import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews } from "@/db/schema";
import {
  isForbiddenEnglishQuestion,
  selectEnglishQuestion,
} from "@/domain/english-question-bank";
import { remainingMsForRole } from "@/domain/interview-plan";
import {
  decideNextQuestion,
  rebuildCoverageState,
  type QuestionControl,
} from "@/domain/question-coverage";
import { QuestionControlSchema } from "@/domain/schemas";
import { buildResearchHandoffInstruction } from "@/lib/experience-interview";
import { buildInterviewContext } from "@/lib/interview-context";
import { interviewerPrompt } from "@/lib/interviewer-prompt";
import { models } from "@/lib/models";
import {
  loadQuestionControls,
  loadQuestionControlSessionState,
} from "@/lib/question-control-store";
import { qwenClient } from "@/lib/qwen";

const answerSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  role: z.enum(["chair", "technical", "research", "english"]),
  atMs: z.number().nonnegative(),
});
const pendingSchema = z.object({
  pendingControlId: z.string().min(1),
  atMs: z.number().nonnegative(),
});
const schema = z.union([answerSchema, pendingSchema]);
const roleLabel = {
  chair: "主考官",
  technical: "专业基础老师",
  research: "科研项目导师",
  english: "英语老师",
} as const;
const englishBoundary = [
  "Ask one short English follow-up about feelings, personal growth, teamwork, motivation, planning, or daily communication.",
  "Do not ask about courses, papers, projects, competitions, algorithms, experiments, or technical details.",
].join("\n");
const researchClaimLeaseMs = 120_000;
const researchClaimWaitMs = 2_000;
const researchClaimPollMs = 20;

type ResearchClaimPayload = { status: "pending" | "completed"; leaseUntil: number | null };
type ResearchClaimResult = { status: "owner"; claimId: string } | { status: "busy" };
type RecentEvent = typeof interviewEvents.$inferSelect;
function questionClaimType(role: "technical" | "research" | "english") {
  return role === "research" ? "research_initial_claim" : `${role}_question_claim`;
}

function readResearchClaim(payload: unknown): ResearchClaimPayload | undefined {
  if (!payload || typeof payload !== "object" || !("status" in payload)) return undefined;
  const status = payload.status;
  if (status !== "pending" && status !== "completed") return undefined;
  const leaseUntil = "leaseUntil" in payload && typeof payload.leaseUntil === "number"
    ? payload.leaseUntil
    : null;
  return { status, leaseUntil };
}

function pendingClaimCondition(interviewId: string, claimId: string, claimType: string) {
  return and(
    eq(interviewEvents.id, claimId),
    eq(interviewEvents.interviewId, interviewId),
    eq(interviewEvents.type, claimType),
    sql`json_extract(${interviewEvents.payload}, '$.status') = 'pending'`,
  );
}

async function releasePendingResearchClaim(interviewId: string, claimId: string, claimType: string) {
  await db.delete(interviewEvents).where(pendingClaimCondition(interviewId, claimId, claimType));
}

async function acquireResearchClaim(interviewId: string, claimType: string): Promise<ResearchClaimResult> {
  const deadline = Date.now() + researchClaimWaitMs;
  while (true) {
    const now = Date.now();
    const claimId = crypto.randomUUID();
    const inserted = await db.insert(interviewEvents).values({
      id: claimId,
      interviewId,
      type: claimType,
      payload: { status: "pending", leaseUntil: now + researchClaimLeaseMs },
      createdAt: now,
    }).onConflictDoNothing().returning({ id: interviewEvents.id });
    if (inserted.length === 1) return { status: "owner", claimId };

    const [existing] = await db.select().from(interviewEvents).where(and(
      eq(interviewEvents.interviewId, interviewId),
      eq(interviewEvents.type, claimType),
    )).limit(1);
    const claim = existing ? readResearchClaim(existing.payload) : undefined;
    if (existing && claim?.status === "completed") {
      const deleted = await db.delete(interviewEvents).where(and(
        eq(interviewEvents.id, existing.id),
        eq(interviewEvents.interviewId, interviewId),
        eq(interviewEvents.type, claimType),
        sql`json_extract(${interviewEvents.payload}, '$.status') = 'completed'`,
      )).returning({ id: interviewEvents.id });
      if (deleted.length === 1) continue;
    }
    if (existing && claim?.status === "pending" && (claim.leaseUntil ?? 0) <= now) {
      const deleted = await db.delete(interviewEvents).where(and(
        pendingClaimCondition(interviewId, existing.id, claimType),
        sql`CAST(json_extract(${interviewEvents.payload}, '$.leaseUntil') AS INTEGER) <= ${now}`,
      )).returning({ id: interviewEvents.id });
      if (deleted.length === 1) continue;
    }
    if (Date.now() >= deadline) return { status: "busy" };
    await new Promise((resolve) => setTimeout(resolve, researchClaimPollMs));
  }
}

function createChairControl(elapsedMs: number, closing: boolean): QuestionControl {
  return {
    role: "chair",
    kind: closing ? "closing" : "new_topic",
    topicId: closing ? "closing" : "chair",
    topicCategory: closing ? "closing" : "chair",
    followUpDepth: 0,
    issuedAtMs: elapsedMs,
  };
}

function transcriptText(event: RecentEvent) {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || !("role" in payload) || !("text" in payload)) {
    return undefined;
  }
  if (typeof payload.role !== "string" || typeof payload.text !== "string") return undefined;
  return { role: payload.role, text: payload.text };
}

function completionText(completion: { choices?: Array<{ message?: { content?: string | null } }> }) {
  return completion.choices?.[0]?.message?.content?.trim() ?? "";
}

function invalidEnglishFollowUp(text: string) {
  const questionMarks = text.match(/[?？]/g)?.length ?? 0;
  return text.length === 0 || questionMarks > 1 || isForbiddenEnglishQuestion(text);
}

async function createModelQuestion(
  messages: Array<{ role: "system" | "user"; content: string }>,
  temperature: number,
) {
  const completion = await qwenClient().chat.completions.create({
    model: models.expressionReview,
    messages,
    max_tokens: 300,
    temperature,
    extra_body: { enable_thinking: false },
  } as never);
  return completionText(completion);
}

async function createEnglishFollowUp(inputText: string, recent: RecentEvent[]) {
  const englishHistory = recent
    .map(transcriptText)
    .filter((turn): turn is { role: string; text: string } => Boolean(turn))
    .filter((turn) => turn.role === "english")
    .slice(-4)
    .map((turn) => turn.text);
  const messages = [
    { role: "system" as const, content: englishBoundary },
    {
      role: "user" as const,
      content: JSON.stringify({ recentEnglishQuestions: englishHistory, candidateAnswer: inputText }),
    },
  ];
  const first = await createModelQuestion(messages, 0.5);
  if (!invalidEnglishFollowUp(first)) return first;
  const retry = await createModelQuestion(messages, 0);
  return invalidEnglishFollowUp(retry) ? undefined : retry;
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

    if ("pendingControlId" in input) {
      const sessionState = await loadQuestionControlSessionState(id);
      const pending = sessionState.pendingControl;
      if (!pending || pending.id !== input.pendingControlId) {
        return NextResponse.json({ error: "待恢复问题不存在或已送达" }, { status: 409 });
      }
      const control = QuestionControlSchema.parse(pending.control);
      let reply: string;
      if (control.role === "english" && control.questionText) {
        reply = control.questionText;
      } else if (control.kind === "closing") {
        reply = await createModelQuestion([{
          role: "system",
          content: `${interviewerPrompt}\n当前角色：${roleLabel.chair}。Ask one short closing question and do not provide feedback or scores.`,
        }], 0.5);
      } else {
        const context = await buildInterviewContext(id);
        const researchInstruction = control.role === "research"
          ? await buildResearchHandoffInstruction(id)
          : undefined;
        reply = await createModelQuestion([{
          role: "system",
          content: [
            interviewerPrompt,
            `当前角色：${roleLabel[control.role]}。这是文字降级模式，只提出一个可直接回答的问题，不提示答案。`,
            `问题控制：${control.kind}，主题：${control.topicCategory}。`,
            context,
            researchInstruction,
          ].filter(Boolean).join("\n"),
        }], 0.5);
      }
      if (!reply) throw new Error("百炼未返回面试问题");

      const now = Date.now();
      await db.transaction(async (tx) => {
        await tx.insert(interviewEvents).values([
          {
            id: crypto.randomUUID(),
            interviewId: id,
            type: "transcript",
            payload: {
              role: control.role,
              startedAtMs: input.atMs,
              endedAtMs: input.atMs,
              text: reply,
              confidence: 1,
              interrupted: false,
            },
            createdAt: now,
          },
          {
            id: crypto.randomUUID(),
            interviewId: id,
            type: "question_delivery",
            payload: { controlId: pending.id, deliveredAtMs: input.atMs },
            createdAt: now + 1,
          },
        ]);
      });
      return NextResponse.json({ reply, control });
    }

    let claimId: string | undefined;
    let claimType: string | undefined;
    if (input.role !== "chair") {
      claimType = questionClaimType(input.role);
      const claim = await acquireResearchClaim(id, claimType);
      if (claim.status === "busy") {
        return NextResponse.json({ error: "面试问题正在生成，请稍后重试" }, { status: 409 });
      }
      claimId = claim.claimId;
    }

    try {
      const duration = interview.duration as 10 | 20 | 30;
      const [recentDescending, controls, priorTranscripts] = await Promise.all([
        db.select().from(interviewEvents)
          .where(eq(interviewEvents.interviewId, id))
          .orderBy(desc(interviewEvents.createdAt))
          .limit(12),
        loadQuestionControls(id),
        db.select({ payload: interviewEvents.payload }).from(interviewEvents).where(and(
          eq(interviewEvents.interviewId, id),
          eq(interviewEvents.type, "transcript"),
        )),
      ]);
      const recent = recentDescending.reverse();
      const hasPriorResearchQuestion = priorTranscripts.some(({ payload }) =>
        payload && typeof payload === "object" && "role" in payload && payload.role === "research",
      );
      let control = input.role === "chair"
        ? createChairControl(input.atMs, input.atMs >= duration * 60_000 - 60_000)
        : decideNextQuestion({
          duration,
          role: input.role,
          elapsedMs: input.atMs,
          moduleRemainingMs: remainingMsForRole(duration, input.role, input.atMs),
          controls,
        });

      let researchInstruction: string | undefined;
      const firstResearchNewTopic = control.role === "research"
        && control.kind === "new_topic"
        && !controls.some((saved) => saved.role === "research" && saved.kind === "new_topic")
        && !hasPriorResearchQuestion;
      if (firstResearchNewTopic) {
        researchInstruction = await buildResearchHandoffInstruction(id);
      }

      let reply: string;
      if (control.kind === "exhausted") {
        reply = "This interview module is completed; please wait for the next section.";
      } else if (control.role === "english" && control.kind === "new_topic") {
        if (!control.questionText) throw new Error("英语题库问题缺少文本");
        reply = control.questionText;
      } else if (control.role === "english") {
        const generated = await createEnglishFollowUp(input.text, recent);
        if (generated) {
          reply = generated;
        } else {
          const state = rebuildCoverageState(controls);
          const fallback = selectEnglishQuestion(
            state.usedEnglishQuestionIds,
            state.usedEnglishCategories,
          );
          control = {
            role: "english",
            kind: "new_topic",
            topicId: fallback.id,
            topicCategory: fallback.category,
            questionId: fallback.id,
            questionText: fallback.text,
            followUpDepth: 0,
            issuedAtMs: input.atMs,
          };
          reply = fallback.text;
        }
      } else if (control.kind === "closing") {
        reply = await createModelQuestion([
          {
            role: "system",
            content: `${interviewerPrompt}\n当前角色：${roleLabel.chair}。Ask one short closing question and do not provide feedback or scores.`,
          },
          { role: "user", content: input.text },
        ], 0.5);
      } else {
        const context = await buildInterviewContext(id);
        const history = recent
          .map(transcriptText)
          .filter((turn): turn is { role: string; text: string } => Boolean(turn))
          .map((turn) => JSON.stringify(turn))
          .join("\n");
        reply = await createModelQuestion([
          {
            role: "system",
            content: [
              interviewerPrompt,
              `当前角色：${roleLabel[control.role]}。这是文字降级模式，只追问一个问题，不提示答案。`,
              `问题控制：${control.kind}，主题：${control.topicCategory}。`,
              context,
              researchInstruction,
            ].filter(Boolean).join("\n"),
          },
          { role: "user", content: `已有转写：\n${history}\n候选人刚才回答：${input.text}` },
        ], 0.5);
      }
      if (!reply) throw new Error("百炼未返回面试问题");

      const validatedControl = QuestionControlSchema.parse(control);
      const now = Date.now();
      await db.transaction(async (tx) => {
        await tx.insert(interviewEvents).values([
          {
            id: crypto.randomUUID(),
            interviewId: id,
            type: "transcript",
            payload: {
              role: "candidate",
              startedAtMs: input.atMs,
              endedAtMs: input.atMs,
              text: input.text,
              confidence: 1,
              interrupted: false,
            },
            createdAt: now,
          },
          {
            id: crypto.randomUUID(),
            interviewId: id,
            type: "transcript",
            payload: {
              role: validatedControl.role,
              startedAtMs: input.atMs + 1,
              endedAtMs: input.atMs + 1,
              text: reply,
              confidence: 1,
              interrupted: false,
            },
            createdAt: now + 1,
          },
          {
            id: crypto.randomUUID(),
            interviewId: id,
            type: "question_control",
            payload: validatedControl,
            createdAt: now + 2,
          },
        ]);
        if (claimId && claimType) {
          const released = await tx.delete(interviewEvents)
            .where(pendingClaimCondition(id, claimId, claimType))
            .returning({ id: interviewEvents.id });
          if (released.length !== 1) throw new Error("问题调度锁所有权已失效，请重试");
        }
        if (interview.status === "ready") {
          await tx.update(interviews).set({ status: "active", startedAt: now })
            .where(eq(interviews.id, id));
        }
      });
      return NextResponse.json({ reply, control: validatedControl });
    } catch (error) {
      if (claimId && claimType) await releasePendingResearchClaim(id, claimId, claimType);
      throw error;
    }
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "文字面试失败",
    }, { status: 400 });
  }
}
