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
}).strict().refine(
  (value) => detailFields.some((field) => value[field].length > 0),
  { message: "详细经历至少需要一项描述" },
);

const smartExtractionSchema = z.object({
  facts: z.array(smartFactSchema).max(100),
  experiences: z.array(extractedExperienceSchema).max(30),
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

function filterSmartFacts(
  facts: SmartFact[],
  pages: ParsedPage[],
  source: string,
): EvidenceFactInput[] {
  return facts
    .filter((fact) =>
      !isHeadingOnly(fact)
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

function validatesExperienceEvidence(
  experience: z.infer<typeof extractedExperienceSchema>,
  pages: ParsedPage[],
) {
  const page = pages.find((candidate) => candidate.page === experience.page);
  if (!page || !containsEvidence(page.text, experience.evidence.title)) return false;
  if (!detailFields.some((field) => experience[field].trim().length > 0)) return false;
  return detailFields.every((field) => {
    if (!experience[field].trim()) return experience.evidence[field] === undefined;
    const evidence = experience.evidence[field];
    return typeof evidence === "string" && containsEvidence(page.text, evidence);
  });
}

function filterExperiences(
  experiences: z.infer<typeof extractedExperienceSchema>[],
  pages: ParsedPage[],
  source: string,
): ExtractedExperience[] {
  const seen = new Set<string>();
  return experiences
    .filter((experience) => validatesExperienceEvidence(experience, pages))
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
    user: `请分析以下逐页材料。事实 value 必须有实质含义；详细经历至少包含一项非空详情。\n\n${renderPages(pages)}`,
    schema: smartExtractionSchema,
    temperature: 0.1,
    enableThinking: false,
    timeoutMs: 120_000,
  }));

  return {
    facts: filterSmartFacts(parsed.facts, pages, source),
    experiences: filterExperiences(parsed.experiences, pages, source),
  };
}

export async function extractSmartFacts(
  pages: ParsedPage[],
  source: string,
  invoke: SmartExtractionInvoke = qwenJson,
): Promise<EvidenceFactInput[]> {
  const compatibleInvoke: SmartExtractionInvoke = async (options) => {
    const result = await invoke(options);
    if (result && typeof result === "object" && "facts" in result && !("experiences" in result)) {
      return { ...result, experiences: [] };
    }
    return result;
  };
  return (await extractSmartMaterialProfile(pages, source, compatibleInvoke)).facts;
}
