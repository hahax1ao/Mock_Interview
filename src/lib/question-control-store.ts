import { and, asc, eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviewEvents } from "@/db/schema";
import type { QuestionControl } from "@/domain/question-coverage";
import { QuestionControlSchema } from "@/domain/schemas";

export async function loadQuestionControls(
  interviewId: string,
): Promise<QuestionControl[]> {
  await initDatabase();
  const rows = await db.select({ payload: interviewEvents.payload })
    .from(interviewEvents)
    .where(and(
      eq(interviewEvents.interviewId, interviewId),
      eq(interviewEvents.type, "question_control"),
    ))
    .orderBy(asc(interviewEvents.createdAt));
  return rows.map(({ payload }) => QuestionControlSchema.parse(payload));
}

export async function saveQuestionControl(
  interviewId: string,
  control: QuestionControl,
): Promise<void> {
  await initDatabase();
  const payload = QuestionControlSchema.parse(control);
  await db.insert(interviewEvents).values({
    id: crypto.randomUUID(),
    interviewId,
    type: "question_control",
    payload,
    createdAt: Date.now(),
  });
}