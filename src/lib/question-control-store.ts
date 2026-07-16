import { and, asc, eq, inArray } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviewEvents } from "@/db/schema";
import type { QuestionControl } from "@/domain/question-coverage";
import { QuestionControlSchema, QuestionDeliverySchema } from "@/domain/schemas";

export type PendingQuestionControl = {
  id: string;
  control: QuestionControl;
};

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
    .orderBy(asc(interviewEvents.createdAt), asc(interviewEvents.id));
  return rows.map(({ payload }) => QuestionControlSchema.parse(payload));
}

export async function loadQuestionControlSessionState(interviewId: string): Promise<{
  controls: QuestionControl[];
  pendingControl?: PendingQuestionControl;
}> {
  await initDatabase();
  const rows = await db.select({
    id: interviewEvents.id,
    type: interviewEvents.type,
    payload: interviewEvents.payload,
  }).from(interviewEvents)
    .where(and(
      eq(interviewEvents.interviewId, interviewId),
      inArray(interviewEvents.type, ["question_control", "question_delivery", "transcript"]),
    ))
    .orderBy(asc(interviewEvents.createdAt), asc(interviewEvents.id));
  const controlRows = rows.flatMap((row) => row.type === "question_control"
    ? [{ id: row.id, control: QuestionControlSchema.parse(row.payload) }]
    : []);
  const lastControl = controlRows.at(-1);
  if (!lastControl) return { controls: [] };
  const delivered = rows.some((row) => {
    if (row.type !== "question_delivery") return false;
    const parsed = QuestionDeliverySchema.safeParse(row.payload);
    return parsed.success && parsed.data.controlId === lastControl.id;
  });
  const controlIndex = rows.findIndex((row) => row.id === lastControl.id);
  const hasInterviewerTranscript = rows.slice(controlIndex + 1).some((row) => {
    if (row.type !== "transcript" || !row.payload || typeof row.payload !== "object") return false;
    return "role" in row.payload && row.payload.role === lastControl.control.role;
  });
  return {
    controls: controlRows.map(({ control }) => control),
    ...(!delivered && !hasInterviewerTranscript ? { pendingControl: lastControl } : {}),
  };
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