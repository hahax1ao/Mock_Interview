import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews } from "@/db/schema";
import type { QuestionControl } from "@/domain/question-coverage";
import { loadQuestionControls, saveQuestionControl } from "./question-control-store";

const interviewId = "00000000-0000-4000-8000-000000000103";

const firstControl: QuestionControl = {
  role: "technical",
  kind: "new_topic",
  topicId: "signals",
  topicCategory: "signals",
  followUpDepth: 0,
  issuedAtMs: 1000,
};

const secondControl: QuestionControl = {
  ...firstControl,
  kind: "follow_up",
  followUpDepth: 1,
  issuedAtMs: 2000,
};

beforeEach(async () => {
  await initDatabase();
  await db.insert(interviews).values({
    id: interviewId,
    status: "active",
    duration: 10,
    focus: "question-control-store",
    pressure: "adaptive",
    materialIds: [],
    plan: [],
    createdAt: 1,
  });
});

afterEach(async () => {
  await db.delete(interviews).where(eq(interviews.id, interviewId));
});

describe("question-control store", () => {
  it("loads controls in createdAt order", async () => {
    await db.insert(interviewEvents).values([
      {
        id: crypto.randomUUID(),
        interviewId,
        type: "question_control",
        payload: secondControl,
        createdAt: 200,
      },
      {
        id: crypto.randomUUID(),
        interviewId,
        type: "question_control",
        payload: firstControl,
        createdAt: 100,
      },
    ]);

    await expect(loadQuestionControls(interviewId)).resolves.toEqual([
      firstControl,
      secondControl,
    ]);
  });

  it("persists a validated control", async () => {
    await saveQuestionControl(interviewId, firstControl);

    await expect(loadQuestionControls(interviewId)).resolves.toEqual([firstControl]);
    const rows = await db.select().from(interviewEvents)
      .where(eq(interviewEvents.interviewId, interviewId));
    expect(rows).toEqual([
      expect.objectContaining({
        type: "question_control",
        payload: firstControl,
      }),
    ]);
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects an invalid control before persistence", async () => {
    const invalidControl = { ...firstControl, followUpDepth: 4 } as QuestionControl;

    await expect(saveQuestionControl(interviewId, invalidControl)).rejects.toThrow();
    await expect(loadQuestionControls(interviewId)).resolves.toEqual([]);
  });

  it("rejects an invalid stored payload", async () => {
    await db.insert(interviewEvents).values({
      id: crypto.randomUUID(),
      interviewId,
      type: "question_control",
      payload: { ...firstControl, followUpDepth: 4 },
      createdAt: 100,
    });

    await expect(loadQuestionControls(interviewId)).rejects.toThrow();
  });
});
