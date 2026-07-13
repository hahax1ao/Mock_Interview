import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews } from "@/db/schema";
import { aggregateReview, type ReviewEntry } from "@/domain/scoring";
import { ReviewEntrySchema } from "@/domain/schemas";
import { buildInterviewContext } from "./interview-context";
import { models } from "./models";
import { qwenJson } from "./qwen";

const reviewerResultSchema = z.object({ entries: z.array(ReviewEntrySchema).min(1) });
const synthesisSchema = z.object({
  priorityIssues: z.array(z.object({ title: z.string(), action: z.string() })).max(5),
  sampleAnswers: z.array(z.object({ question: z.string(), answer: z.string() })).max(5),
  trainingPlan: z.array(z.object({ day: z.number().min(1).max(7), task: z.string(), target: z.string() })).length(7),
});

const reviewerConfigs = [
  { reviewer: "chair", model: models.expressionReview, dimensions: ["logic", "authenticity", "pressure"] },
  { reviewer: "technical", model: models.technicalReview, dimensions: ["technical", "logic"] },
  { reviewer: "research", model: models.researchReview, dimensions: ["research", "authenticity"] },
  { reviewer: "english", model: models.englishReview, dimensions: ["english", "logic"] },
] as const;
const configuredReviewConcurrency = Number(process.env.QWEN_REVIEW_CONCURRENCY ?? 2);
const reviewConcurrency = Number.isInteger(configuredReviewConcurrency)
  ? Math.min(4, Math.max(1, configuredReviewConcurrency))
  : 1;

export async function runReview(interviewId: string) {
  await initDatabase();
  const [interview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
  if (!interview) throw new Error("面试场次不存在");
  const [events, materialContext] = await Promise.all([
    db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, interviewId)),
    buildInterviewContext(interviewId),
  ]);
  const transcript = events
    .filter((event) => event.type === "transcript")
    .sort((a, b) => (Number((a.payload as { startedAtMs?: number }).startedAtMs ?? a.createdAt) - Number((b.payload as { startedAtMs?: number }).startedAtMs ?? b.createdAt)) || a.createdAt - b.createdAt)
    .map((event) => JSON.stringify(event.payload))
    .join("\n");
  if (!transcript) throw new Error("没有可供复盘的转写记录");

  const shared = `面试方向：${interview.focus}
压力等级：${interview.pressure}
转写：
${transcript}
${materialContext}`;

  const settled: PromiseSettledResult<z.infer<typeof reviewerResultSchema>>[] = [];
  for (let index = 0; index < reviewerConfigs.length; index += reviewConcurrency) {
    const batch = reviewerConfigs.slice(index, index + reviewConcurrency);
    settled.push(...await Promise.allSettled(batch.map(async (config) => {
      const result = await qwenJson({
        model: config.model,
        system: `你是保研模拟面试的${config.reviewer}评审。仅评价维度 ${config.dimensions.join(", ")}。
每个指定维度仅输出一条 0–100 分的评分，每条评分仅提供一条最关键证据，文字务必简洁，字段必须完整。专业结论若无用户资料支撑，source 写“模型复核”，confidence 不得高于 0.7，且不能单独造成重大扣分。
返回 {"entries":[{"reviewer":"${config.reviewer}","dimension":"...","score":0,"evidence":[{"question":"...","answer":"...","issueType":"knowledge","explanation":"...","suggestion":"...","source":"...","confidence":0.8}]}]}。`,
        user: shared,
        schema: reviewerResultSchema,
        maxTokens: 700,
      });
      const entries = result.entries.filter((entry) => entry.reviewer === config.reviewer && config.dimensions.includes(entry.dimension as never));
      if (entries.length !== config.dimensions.length || config.dimensions.some((dimension) => !entries.some((entry) => entry.dimension === dimension))) {
        throw new Error(`${config.reviewer} 评审缺少预期维度`);
      }
      return { entries };
    })));
  }

  const entries = settled.flatMap((result) => result.status === "fulfilled" ? result.value.entries : []) as ReviewEntry[];
  if (!entries.length) {
    const messages = settled.map((result) => result.status === "rejected" ? String(result.reason) : "").filter(Boolean);
    throw new Error(messages.join("; ") || "所有评审均失败");
  }

  const aggregate = aggregateReview(entries);
  const fallbackEvidence = entries.flatMap((entry) => entry.evidence).slice(0, 5);
  let coaching: z.infer<typeof synthesisSchema> = {
    priorityIssues: fallbackEvidence.map((item) => ({ title: item.issueType, action: item.suggestion })).slice(0, 5),
    sampleAnswers: fallbackEvidence.map((item) => ({ question: item.question, answer: item.suggestion })).slice(0, 5),
    trainingPlan: Array.from({ length: 7 }, (_, index) => ({
      day: index + 1,
      task: fallbackEvidence[index % Math.max(1, fallbackEvidence.length)]?.suggestion ?? "完成一次限时口述并复盘",
      target: "表达准确、证据充分、控制在 90 秒内",
    })),
  };

  try {
    coaching = await qwenJson({
      model: models.synthesis,
      system: `你是主考官评审，只基于给定评分和证据生成最多五个优先问题、对应示范回答与恰好七天训练计划。
返回 {"priorityIssues":[{"title":"...","action":"..."}],"sampleAnswers":[{"question":"...","answer":"..."}],"trainingPlan":[{"day":1,"task":"...","target":"..."}]}。`,
      user: JSON.stringify({ aggregate, entries }),
      schema: synthesisSchema,
      maxTokens: 1_200,
    });
  } catch {
    // Individual scores remain usable when synthesis alone fails.
  }

  return {
    ...aggregate,
    ...coaching,
    incomplete: settled.some((result) => result.status === "rejected") || aggregate.totalScore === null,
    failedReviewers: settled.flatMap((result, index) => result.status === "rejected" ? [reviewerConfigs[index].reviewer] : []),
  };
}