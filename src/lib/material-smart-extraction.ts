import { z } from "zod";
import {
  ExperienceEditableObjectSchema,
  ExperienceEvidenceSchema,
} from "../domain/experiences";
import type { ParsedPage } from "./material-parser";
import { models } from "./models";
import { isSolelyLocalProfileData, type EvidenceFactInput } from "./profile-extraction";
import { qwenJson } from "./qwen";

const smartFields = ["项目经历", "科研经历", "竞赛经历", "技能", "荣誉"] as const;
const headingOnlyValues = [
  ...smartFields,
  "专业技能",
  "个人技能",
  "主要荣誉",
  "荣誉奖项",
  "项目经验",
] as const;
const detailFields = ["background", "responsibilities", "methods", "results", "awardRole"] as const;
const contactLabel = String.raw`(?:姓名|联系方式|联系电话|备用电话|手机|电话|邮箱|电子邮件|地址|住址|联系地址|微信|QQ|社交账号)`;
const contactLabelPattern = new RegExp(`${contactLabel}\\s*(?:[：:]\\s*|\\s+)(?=\\S)`, "iu");
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const phonePattern = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu;
const metricContextPattern = /(?:结果|指标|累计|吞吐|速率|数量|处理|符号|样本|字节|周期|频率|误码|精度|参数)/u;
const experienceAnchorPattern = /\u9879\u76ee|\u79d1\u7814|\u8bfe\u9898|\u7ade\u8d5b|\u6bd4\u8d5b|\u6280\u80fd|\u8363\u8a89|\u804c\u8d23|\u8d1f\u8d23|\u65b9\u6cd5|\u7b97\u6cd5|\u5b9e\u73b0|\u7ed3\u679c|\u6307\u6807|\u83b7\u5956|\u901a\u4fe1|\u7535\u8def|\u5d4c\u5165\u5f0f|FPGA|LoRa/iu;

const smartFactSchema = z.object({
  field: z.enum(smartFields),
  value: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(1_000),
  page: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
}).strict();

const extractedExperienceSchema = ExperienceEditableObjectSchema.extend({
  page: z.number().int().positive(),
  evidence: ExperienceEvidenceSchema,
  confidence: z.number().min(0).max(1),
}).strict();

const smartExtractionSchema = z.object({
  facts: z.array(smartFactSchema).max(100),
  experiences: z.array(extractedExperienceSchema),
}).strict();

type SmartFact = z.infer<typeof smartFactSchema>;
type SmartExtractionResult = z.infer<typeof smartExtractionSchema>;
export type ExtractedExperience = z.infer<typeof extractedExperienceSchema> & { source: string };

export type SmartExtractionInvoke = (options: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<SmartExtractionResult>;
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean;
  timeoutMs?: number;
}) => Promise<unknown>;

const normalizeEvidence = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
const containsEvidence = (text: string, evidence: string) => {
  const normalized = normalizeEvidence(evidence);
  return normalized.length > 0 && normalizeEvidence(text).includes(normalized);
};

export function validateSmartEvidence(fact: SmartFact, pages: ParsedPage[]): boolean {
  const page = pages.find((candidate) => candidate.page === fact.page);
  return Boolean(page && containsEvidence(page.text, fact.evidence));
}

const isHeadingOnly = (fact: SmartFact) => {
  const value = normalizeEvidence(fact.value).replace(/[：:]+$/u, "");
  return headingOnlyValues.some((heading) => value === normalizeEvidence(heading));
};

function renderPages(pages: ParsedPage[]) {
  return pages.map((page) => `[第 ${page.page} 页]\n${page.text}`).join("\n\n");
}

function sanitizeContactText(value: string, labelledReplacement = "") {
  return value.split(/\r?\n/u).map((originalLine) => {
    let line = originalLine;
    const label = contactLabelPattern.exec(line);
    if (label?.index === 0) {
      line = labelledReplacement;
    } else if (label && !/(?:电话|手机|邮箱|电子邮件|联系方式)/u.test(label[0])) {
      line = line.slice(0, label.index).replace(/[\s,，;；|/]+$/u, "");
    }
    line = line.replace(emailPattern, "[email removed]");
    const labelledPhone = Boolean(label && /(?:电话|手机|联系方式)/u.test(label[0]));
    if (labelledPhone || !metricContextPattern.test(line)) line = line.replace(phonePattern, "[phone removed]");
    return line;
  }).join("\n").trim();
}

function redactContactLine(line: string) {
  return sanitizeContactText(line, "[contact removed]");
}

function candidatePages(pages: ParsedPage[]): ParsedPage[] {
  return pages.map((page) => {
    const lines = page.text.split(/\r?\n/u);
    const anchors = lines.flatMap((line, index) =>
      experienceAnchorPattern.test(line) ? [index] : [],
    );
    const selected = anchors.length === 0
      ? lines
      : lines.filter((_, index) =>
          anchors.some((anchor) => Math.abs(anchor - index) <= 8),
        );
    let text = selected.map(redactContactLine).join("\n");
    if (anchors.length === 0 && text.length > 6_000) {
      text = `${text.slice(0, 3_000)}\n[bounded fallback omitted]\n${text.slice(-3_000)}`;
    }
    return { ...page, text };
  });
}

const MAX_CHUNK_PAGES = 10;
const MAX_CHUNK_CHARACTERS = 10_500;
const CHUNK_OVERLAP_CHARACTERS = 200;

function splitOversizedPages(pages: ParsedPage[]): ParsedPage[] {
  return pages.flatMap((page) => {
    if (page.text.length <= MAX_CHUNK_CHARACTERS) return [page];
    const segments: ParsedPage[] = [];
    let start = 0;
    while (start < page.text.length) {
      const end = Math.min(start + MAX_CHUNK_CHARACTERS, page.text.length);
      segments.push({ ...page, text: page.text.slice(start, end) });
      if (end === page.text.length) break;
      start = end - CHUNK_OVERLAP_CHARACTERS;
    }
    return segments;
  });
}

function chunkCandidatePages(pages: ParsedPage[]): ParsedPage[][] {
  const chunks: ParsedPage[][] = [];
  let current: ParsedPage[] = [];
  let characters = 0;
  for (const page of pages) {
    if (
      current.length > 0
      && (current.length >= MAX_CHUNK_PAGES || characters + page.text.length > MAX_CHUNK_CHARACTERS)
    ) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(page);
    characters += page.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function filterSmartFacts(
  facts: SmartFact[],
  pages: ParsedPage[],
  source: string,
): EvidenceFactInput[] {
  return facts
    .map((fact) => ({
      ...fact,
      value: sanitizeContactText(fact.value),
      evidence: sanitizeContactText(fact.evidence),
    }))
    .filter((fact) =>
      !isHeadingOnly(fact)
      && fact.value.length > 0
      && fact.evidence.length > 0
      && !isSolelyLocalProfileData(fact.value)
      && !isSolelyLocalProfileData(fact.evidence)
      && validateSmartEvidence(fact, pages),
    )
    .map((fact) => ({
      ...fact,
      source,
      confidence: Math.min(fact.confidence, 0.9),
      extractor: "qwen" as const,
    }));
}

function retainEvidenceBackedFields(
  experience: z.infer<typeof extractedExperienceSchema>,
  pages: ParsedPage[],
) {
  const page = pages.find((candidate) => candidate.page === experience.page);
  const title = sanitizeContactText(experience.title);
  const titleEvidence = sanitizeContactText(experience.evidence.title);
  if (!page || !title || !titleEvidence || !containsEvidence(page.text, titleEvidence)) return undefined;
  const evidence = { title: titleEvidence } as z.infer<typeof ExperienceEvidenceSchema>;
  const sanitized = { ...experience, title, evidence };
  for (const field of detailFields) {
    const fieldValue = sanitizeContactText(experience[field]);
    const rawEvidence = experience.evidence[field];
    const fieldEvidence = typeof rawEvidence === "string" ? sanitizeContactText(rawEvidence) : "";
    if (fieldValue && fieldEvidence && containsEvidence(page.text, fieldEvidence)) {
      sanitized[field] = fieldValue;
      evidence[field] = fieldEvidence;
    } else {
      sanitized[field] = "";
    }
  }
  return detailFields.some((field) => sanitized[field].trim()) ? sanitized : undefined;
}

function filterExperiences(
  experiences: z.infer<typeof extractedExperienceSchema>[],
  pages: ParsedPage[],
  source: string,
): ExtractedExperience[] {
  const seen = new Set<string>();
  return experiences
    .map((experience) => retainEvidenceBackedFields(experience, pages))
    .filter((experience): experience is z.infer<typeof extractedExperienceSchema> => experience !== undefined)
    .filter((experience) => {
      const key = `${experience.type}:${normalizeEvidence(experience.title).toLocaleLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((experience) => ({
      ...experience,
      source,
      confidence: Math.min(experience.confidence, 0.9),
    }));
}

export async function extractSmartMaterialProfile(
  pages: ParsedPage[],
  source: string,
  invoke: SmartExtractionInvoke = qwenJson,
): Promise<{
  facts: EvidenceFactInput[];
  experiences: ExtractedExperience[];
  chunks: { total: number; succeeded: number; failed: number };
}> {
  const safeCandidatePages = candidatePages(pages);
  const chunks = chunkCandidatePages(splitOversizedPages(safeCandidatePages));
  const parsedResults: SmartExtractionResult[] = [];
  let firstError: unknown;
  for (const chunk of chunks) {
    try {
      const parsed = smartExtractionSchema.parse(await invoke({
    model: models.materialExtraction,
    system: [
      "你负责从申请材料中提取可核验的经历、能力事实和详细经历卡片。",
      "事实仅可使用字段：项目经历、科研经历、竞赛经历、技能、荣誉。",
      "即使 PDF 阅读顺序错乱，也要按语义分类，不可依赖相邻标题猜测。",
      "每条事实和经历卡片的每个非空字段都必须返回材料中的逐字证据和真实页码。",
      "每个彼此独立且有实质描述的经历返回一张卡片，不得合并互不相关的经历。",
      "经历识别必须是通用语义判断，不得使用基于名称的白名单。",
      "标题也必须有同页逐字证据；空白详情字段不得返回对应 evidence。",
      "不得提取联系方式，包括姓名、电话、邮箱、住址、社交账号或其他个人联络信息。",
      "不得把本地规则负责的 CET4/CET6、GPA/平均成绩、排名、目标方向或课程标签包装成经历或事实。",
      'Return exactly this root object and no other root keys: {"facts":[],"experiences":[]}',
      'facts 中每一项必须严格使用这个形状：{"field":"项目经历|科研经历|竞赛经历|技能|荣誉","value":"string","evidence":"string","page":1,"confidence":0.0}。field 必须且只能从竖线分隔的五个中文枚举值中选择一个；page 必须是正整数；confidence 必须在 0 到 1 之间。',
      'experiences 中每一项必须严格使用这个形状：{"type":"research|project|competition","title":"string","background":"string","responsibilities":"string","methods":"string","results":"string","awardRole":"string","page":1,"evidence":{"title":"string","background":"string or omit","responsibilities":"string or omit","methods":"string or omit","results":"string or omit","awardRole":"string or omit"},"confidence":0.0}。type 必须且只能从竖线分隔的三个英文枚举值中选择一个。',
      '经历的 title、background、responsibilities、methods、results、awardRole 六个正文键都必须存在；缺少内容时正文值使用空字符串。evidence.title 必须存在；其他 evidence 键仅在对应正文非空且有同页逐字证据时返回，否则必须省略该键，不得使用 null。',
      'facts 禁止使用别名 type、value_evidence；experiences 禁止使用别名 title_evidence、description、description_evidence。facts、experiences、其中的对象以及 evidence 对象均不得增加任何其他字段。只输出 JSON，不要输出解释或 Markdown。',
    ].join("\n"),
    user: `请分析以下逐页材料。事实 value 必须有实质含义；详细经历至少包含一项非空详情。\n\n${renderPages(chunk)}`,
    schema: smartExtractionSchema,
    temperature: 0.1,
    maxTokens: 8_000,
    enableThinking: false,
    timeoutMs: 120_000,
      }));
      parsedResults.push(parsed);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (parsedResults.length === 0 && firstError) throw firstError;

  return {
    facts: filterSmartFacts(parsedResults.flatMap((parsed) => parsed.facts), pages, source),
    experiences: filterExperiences(parsedResults.flatMap((parsed) => parsed.experiences), pages, source),
    chunks: {
      total: chunks.length,
      succeeded: parsedResults.length,
      failed: chunks.length - parsedResults.length,
    },
  };
}

export function extractSmartFacts(
  profile: { facts: EvidenceFactInput[] },
): EvidenceFactInput[] {
  return profile.facts;
}
