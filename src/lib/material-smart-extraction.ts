import { z } from "zod";
import type { ParsedPage } from "./material-parser";
import { models } from "./models";
import type { EvidenceFactInput } from "./profile-extraction";
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

const smartFactSchema = z.object({
  field: z.enum(smartFields),
  value: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(1_000),
  page: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
}).strict();

const smartExtractionSchema = z.object({ facts: z.array(smartFactSchema).max(100) }).strict();
type SmartFact = z.infer<typeof smartFactSchema>;
type SmartExtractionResult = z.infer<typeof smartExtractionSchema>;

export type SmartExtractionInvoke = (options: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<SmartExtractionResult>;
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean;
}) => Promise<unknown>;

const normalizeEvidence = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");

export function validateSmartEvidence(fact: SmartFact, pages: ParsedPage[]): boolean {
  const page = pages.find((candidate) => candidate.page === fact.page);
  if (!page) return false;
  const evidence = normalizeEvidence(fact.evidence);
  return evidence.length > 0 && normalizeEvidence(page.text).includes(evidence);
}

const isHeadingOnly = (fact: SmartFact) => {
  const value = normalizeEvidence(fact.value).replace(/[：:]+$/u, "");
  return headingOnlyValues.some((heading) => value === normalizeEvidence(heading));
};

function renderPages(pages: ParsedPage[]) {
  return pages.map((page) => `[第 ${page.page} 页]\n${page.text}`).join("\n\n");
}

export async function extractSmartFacts(
  pages: ParsedPage[],
  source: string,
  invoke: SmartExtractionInvoke = qwenJson,
): Promise<EvidenceFactInput[]> {
  const result = smartExtractionSchema.parse(await invoke({
    model: models.materialExtraction,
    system: [
      "你负责从申请材料中提取可核验的经历与能力事实。",
      "仅可使用字段：项目经历、科研经历、竞赛经历、技能、荣誉。",
      "即使 PDF 阅读顺序错乱，也要按语义分类，不可依赖相邻标题猜测。",
      "每条事实必须返回材料中的逐字证据和真实页码；没有直接支持的事实不要返回。",
      "不得提取联系方式，包括姓名、电话、邮箱、住址、社交账号或其他个人联络信息。",
    ].join("\n"),
    user: `请分析以下逐页材料。每条 value 必须是有意义的事实，不能只是栏目标题。\n\n${renderPages(pages)}`,
    schema: smartExtractionSchema,
    temperature: 0.1,
    enableThinking: false,
  }));

  return result.facts
    .filter((fact) => !isHeadingOnly(fact) && validateSmartEvidence(fact, pages))
    .map((fact) => ({ ...fact, source, confidence: Math.min(fact.confidence, 0.9), extractor: "qwen" }));
}
