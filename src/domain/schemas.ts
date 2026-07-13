import { z } from "zod";

export const InterviewRoleSchema = z.enum(["chair", "technical", "research", "english", "candidate"]);
export type InterviewRole = z.infer<typeof InterviewRoleSchema>;

export const InterviewConfigSchema = z.object({
  materialIds: z.array(z.string()).default([]),
  duration: z.union([z.literal(10), z.literal(20), z.literal(30)]),
  focus: z.string().max(500).default("综合"),
  pressure: z.enum(["gentle", "adaptive", "intense"]).default("adaptive"),
});
export type InterviewConfig = z.infer<typeof InterviewConfigSchema>;

export const ProfileFactSchema = z.object({
  id: z.string(),
  field: z.string().min(1),
  value: z.string().min(1),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1),
  confirmed: z.boolean(),
});
export type ProfileFact = z.infer<typeof ProfileFactSchema>;

export const TranscriptTurnSchema = z.object({
  id: z.string().optional(),
  role: InterviewRoleSchema,
  startedAtMs: z.number().nonnegative(),
  endedAtMs: z.number().nonnegative(),
  text: z.string(),
  confidence: z.number().min(0).max(1).default(1),
  interrupted: z.boolean().default(false),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const InterviewEventSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().uuid().optional(), type: z.literal("transcript"), payload: TranscriptTurnSchema }),
  z.object({ id: z.string().uuid().optional(), type: z.literal("handoff"), payload: z.object({ from: InterviewRoleSchema, to: InterviewRoleSchema, atMs: z.number() }) }),
  z.object({ id: z.string().uuid().optional(), type: z.literal("interruption"), payload: z.object({ atMs: z.number(), role: InterviewRoleSchema }) }),
  z.object({ id: z.string().uuid().optional(), type: z.literal("connection"), payload: z.object({ state: z.enum(["connected", "disconnected", "reconnecting", "text-fallback"]), atMs: z.number() }) }),
]);

const issueTypeAliases: Record<string, string> = {
  "知识": "knowledge", "知识准确性": "knowledge", "专业知识": "knowledge", "专业基础": "knowledge",
  "逻辑": "logic", "逻辑性": "logic", "逻辑表达": "logic",
  "表达": "expression", "表达能力": "expression", "语言表达": "expression",
  "英语": "english", "英语交流": "english",
  "真实性": "authenticity", "项目真实性": "authenticity",
  "抗压": "pressure", "抗压表现": "pressure",
};
const reviewerAliases: Record<string, string> = {
  "主考官": "chair", "专业基础老师": "technical", "专业老师": "technical",
  "科研项目导师": "research", "科研导师": "research", "英语老师": "english",
};
const dimensionAliases: Record<string, string> = {
  "专业基础": "technical", "专业": "technical",
  "项目科研": "research", "科研项目": "research", "科研": "research",
  "逻辑表达": "logic", "逻辑": "logic",
  "英语交流": "english", "英语": "english",
  "真实性": "authenticity", "抗压表现": "pressure", "抗压": "pressure",
};
const normalizeAlias = (aliases: Record<string, string>) =>
  (value: unknown) => typeof value === "string" ? (aliases[value.trim()] ?? value.trim().toLowerCase()) : value;

const normalizeIssueType = (value: unknown) => {
  if (typeof value !== "string") return value;
  const label = value.trim();
  const direct = issueTypeAliases[label] ?? label.toLowerCase();
  if (["knowledge", "logic", "expression", "english", "authenticity", "pressure"].includes(direct)) return direct;
  if (/英语|语法|词汇|english/i.test(label)) return "english";
  if (/真实|一致|可信|贡献/.test(label)) return "authenticity";
  if (/抗压|压力|应变|情绪/.test(label)) return "pressure";
  if (/逻辑|结构|推理|条理/.test(label)) return "logic";
  if (/知识|专业|技术|准确|完整|深度|内容/.test(label)) return "knowledge";
  return "expression";
};
export const EvidenceSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  issueType: z.preprocess(normalizeIssueType, z.enum(["knowledge", "logic", "expression", "english", "authenticity", "pressure"])),
  explanation: z.string().min(1),
  suggestion: z.string().min(1),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const ReviewEntrySchema = z.object({
  reviewer: z.preprocess(normalizeAlias(reviewerAliases), z.enum(["chair", "technical", "research", "english"])),
  dimension: z.preprocess(normalizeAlias(dimensionAliases), z.enum(["technical", "research", "logic", "english", "authenticity", "pressure"])),
  score: z.number().min(0).max(100),
  evidence: z.array(EvidenceSchema).min(1),
});

export const ReviewReportSchema = z.object({
  totalScore: z.number().min(0).max(100),
  level: z.string(),
  dimensions: z.array(z.object({
    dimension: z.string(),
    score: z.number(),
    level: z.string(),
    evidence: z.array(EvidenceSchema),
  })),
  disagreements: z.array(z.unknown()),
  priorityIssues: z.array(z.object({ title: z.string(), action: z.string() })).max(5),
  sampleAnswers: z.array(z.object({ question: z.string(), answer: z.string() })).max(5),
  trainingPlan: z.array(z.object({ day: z.number().min(1).max(7), task: z.string(), target: z.string() })).length(7),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
