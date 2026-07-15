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
const contactLabelPattern = /(?:\u59d3\u540d|\u8054\u7cfb\u65b9\u5f0f|\u8054\u7cfb\u7535\u8bdd|\u624b\u673a|\u7535\u8bdd|\u90ae\u7bb1|\u7535\u5b50\u90ae\u4ef6|\u5730\u5740|\u4f4f\u5740|\u8054\u7cfb\u5730\u5740|\u5fae\u4fe1|QQ|\u793e\u4ea4\u8d26\u53f7)\s*[\uFF1A:]/iu;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const phonePattern = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/u;
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

const containsContactData = (value: string) =>
  contactLabelPattern.test(value) || emailPattern.test(value) || phonePattern.test(value);

function redactContactLine(line: string) {
  if (contactLabelPattern.test(line)) return "[contact removed]";
  return line
    .replace(emailPattern, "[email removed]")
    .replace(phonePattern, "[phone removed]");
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
    return { ...page, text: selected.map(redactContactLine).join("\n") };
  });
}

const MAX_CHUNK_PAGES = 10;
const MAX_CHUNK_CHARACTERS = 12_000;

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
    .filter((fact) =>
      !isHeadingOnly(fact)
      && !containsContactData(fact.value)
      && !containsContactData(fact.evidence)
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
  if (
    !page
    || containsContactData(experience.title)
    || containsContactData(experience.evidence.title)
    || !containsEvidence(page.text, experience.evidence.title)
  ) return undefined;
  const evidence = { title: experience.evidence.title } as z.infer<typeof ExperienceEvidenceSchema>;
  const sanitized = { ...experience, evidence };
  for (const field of detailFields) {
    const fieldEvidence = experience.evidence[field];
    if (
      experience[field].trim()
      && typeof fieldEvidence === "string"
      && !containsContactData(experience[field])
      && !containsContactData(fieldEvidence)
      && containsEvidence(page.text, fieldEvidence)
    ) {
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
): Promise<{ facts: EvidenceFactInput[]; experiences: ExtractedExperience[] }> {
  const safeCandidatePages = candidatePages(pages);
  const chunks = chunkCandidatePages(safeCandidatePages);
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
  };
}

export function extractSmartFacts(
  profile: { facts: EvidenceFactInput[] },
): EvidenceFactInput[] {
  return profile.facts;
}
