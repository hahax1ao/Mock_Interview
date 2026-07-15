import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews } from "@/db/schema";
import { buildResearchHandoffInstruction } from "@/lib/experience-interview";
import { buildInterviewContext } from "@/lib/interview-context";
import { interviewerPrompt } from "@/lib/interviewer-prompt";
import { models } from "@/lib/models";
import { qwenClient } from "@/lib/qwen";

const schema = z.object({
  text: z.string().trim().min(1).max(4000),
  role: z.enum(["chair", "technical", "research", "english"]),
  atMs: z.number().nonnegative(),
});
const roleLabel = { chair: "主考官", technical: "专业基础老师", research: "科研项目导师", english: "英语老师" } as const;
const researchClaimType = "research_initial_claim";
const researchClaimLeaseMs = 120_000;
const researchClaimWaitMs = 2_000;
const researchClaimPollMs = 20;

type ResearchClaimPayload = { status: "pending" | "completed"; leaseUntil: number | null };
type ResearchClaimResult = { status: "owner"; claimId: string } | { status: "completed" | "busy" };

function readResearchClaim(payload: unknown): ResearchClaimPayload | undefined {
  if (!payload || typeof payload !== "object" || !("status" in payload)) return undefined;
  const status = payload.status;
  if (status !== "pending" && status !== "completed") return undefined;
  const leaseUntil = "leaseUntil" in payload && typeof payload.leaseUntil === "number"
    ? payload.leaseUntil
    : null;
  return { status, leaseUntil };
}

function pendingClaimCondition(interviewId: string, claimId: string) {
  return and(
    eq(interviewEvents.id, claimId),
    eq(interviewEvents.interviewId, interviewId),
    eq(interviewEvents.type, researchClaimType),
    sql`json_extract(${interviewEvents.payload}, '$.status') = 'pending'`,
  );
}

async function releasePendingResearchClaim(interviewId: string, claimId: string) {
  await db.delete(interviewEvents).where(pendingClaimCondition(interviewId, claimId));
}

async function acquireResearchClaim(interviewId: string): Promise<ResearchClaimResult> {
  const deadline = Date.now() + researchClaimWaitMs;
  while (true) {
    const now = Date.now();
    const claimId = crypto.randomUUID();
    const inserted = await db.insert(interviewEvents).values({
      id: claimId,
      interviewId,
      type: researchClaimType,
      payload: { status: "pending", leaseUntil: now + researchClaimLeaseMs },
      createdAt: now,
    }).onConflictDoNothing().returning({ id: interviewEvents.id });
    if (inserted.length === 1) return { status: "owner", claimId };

    const [existing] = await db.select().from(interviewEvents).where(and(
      eq(interviewEvents.interviewId, interviewId),
      eq(interviewEvents.type, researchClaimType),
    )).limit(1);
    const claim = existing ? readResearchClaim(existing.payload) : undefined;
    if (claim?.status === "completed") return { status: "completed" };
    if (existing && claim?.status === "pending" && (claim.leaseUntil ?? 0) <= now) {
      const deleted = await db.delete(interviewEvents).where(and(
        pendingClaimCondition(interviewId, existing.id),
        sql`CAST(json_extract(${interviewEvents.payload}, '$.leaseUntil') AS INTEGER) <= ${now}`,
      )).returning({ id: interviewEvents.id });
      if (deleted.length === 1) continue;
    }
    if (Date.now() >= deadline) return { status: "busy" };
    await new Promise((resolve) => setTimeout(resolve, researchClaimPollMs));
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = schema.parse(await request.json());
    await initDatabase();

      const [interview] = await db.select().from(interviews).where(eq(interviews.id, id));
      if (!interview || !["ready", "active"].includes(interview.status)) {
        return NextResponse.json({ error: "场次不存在或已结束" }, { status: 409 });
      }
      const [context, recent, priorTranscripts] = await Promise.all([
        buildInterviewContext(id),
        db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, id)).orderBy(desc(interviewEvents.createdAt)).limit(12),
        db.select({ payload: interviewEvents.payload }).from(interviewEvents).where(and(
          eq(interviewEvents.interviewId, id),
          eq(interviewEvents.type, "transcript"),
        )),
      ]);
      const hasPriorResearchQuestion = priorTranscripts.some(({ payload }) =>
        typeof payload === "object" && payload !== null && "role" in payload && payload.role === "research",
      );
      let researchInstruction: string | undefined;
      let claimId: string | undefined;
      if (input.role === "research" && !hasPriorResearchQuestion) {
        const claim = await acquireResearchClaim(id);
        if (claim.status === "busy") {
          return NextResponse.json({ error: "首个科研问题正在生成，请稍后重试" }, { status: 409 });
        }
        if (claim.status === "owner") {
          claimId = claim.claimId;
          try {
            researchInstruction = await buildResearchHandoffInstruction(id);
          } catch (error) {
            await releasePendingResearchClaim(id, claimId);
            throw error;
          }
        }
      }
      const history = recent.reverse().filter((event) => event.type === "transcript").map((event) => JSON.stringify(event.payload)).join("\n");
      try {
        const completion = await qwenClient().chat.completions.create({
          model: models.expressionReview,
          messages: [
            { role: "system", content: `${interviewerPrompt}\n当前角色：${roleLabel[input.role]}。这是文字降级模式，只追问一个问题，不提示答案。${context}${researchInstruction ? `\n${researchInstruction}` : ""}` },
            { role: "user", content: `已有转写：\n${history}\n候选人刚才回答：${input.text}` },
          ],
          max_tokens: 300,
          temperature: 0.5,
          extra_body: { enable_thinking: false },
        } as never);
        const reply = completion.choices[0]?.message?.content?.trim();
        if (!reply) throw new Error("百炼未返回面试问题");
        const now = Date.now();
        await db.transaction(async (tx) => {
          if (claimId) {
            const completed = await tx.update(interviewEvents).set({
              payload: { status: "completed", leaseUntil: null },
            }).where(pendingClaimCondition(id, claimId)).returning({ id: interviewEvents.id });
            if (completed.length !== 1) throw new Error("科研首问所有权已失效，请重试");
          }
          await tx.insert(interviewEvents).values([
            { id: crypto.randomUUID(), interviewId: id, type: "transcript", payload: { role: "candidate", startedAtMs: input.atMs, endedAtMs: input.atMs, text: input.text, confidence: 1, interrupted: false }, createdAt: now },
            { id: crypto.randomUUID(), interviewId: id, type: "transcript", payload: { role: input.role, startedAtMs: input.atMs + 1, endedAtMs: input.atMs + 1, text: reply, confidence: 1, interrupted: false }, createdAt: now + 1 },
          ]);
          if (interview.status === "ready") await tx.update(interviews).set({ status: "active", startedAt: now }).where(eq(interviews.id, id));
        });
        return NextResponse.json({ reply });
      } catch (error) {
        if (claimId) {
          await releasePendingResearchClaim(id, claimId);
        }
        throw error;
      }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "文字面试失败" }, { status: 400 });
  }
}