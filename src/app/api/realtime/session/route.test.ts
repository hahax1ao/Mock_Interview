import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews, materials, profileExperiences } from "@/db/schema";
import type { QuestionControl } from "@/domain/question-coverage";
import { POST } from "./route";

const createdInterviewIds: string[] = [];
const createdMaterialIds: string[] = [];
let originalApiKey: string | undefined;

beforeEach(async () => {
  originalApiKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "test-only-session-route-key";
  await initDatabase();
});

afterEach(async () => {
  for (const interviewId of createdInterviewIds.splice(0)) {
    await db.delete(interviews).where(eq(interviews.id, interviewId));
  }
  for (const materialId of createdMaterialIds.splice(0)) {
    await db.delete(materials).where(eq(materials.id, materialId));
  }
  if (originalApiKey === undefined) delete process.env.DASHSCOPE_API_KEY;
  else process.env.DASHSCOPE_API_KEY = originalApiKey;
});

async function createInterviewFixture(withConfirmedExperience: boolean) {
  const materialId = crypto.randomUUID();
  const interviewId = crypto.randomUUID();
  createdMaterialIds.push(materialId);
  createdInterviewIds.push(interviewId);
  await db.insert(materials).values({
    id: materialId, name: "resume.pdf", category: "personal", mimeType: "application/pdf",
    filePath: "test-only-resume.pdf", createdAt: 1,
  });
  await db.insert(interviews).values({
    id: interviewId, status: "ready", duration: 20, focus: "LoRa 通信",
    pressure: "adaptive", materialIds: [materialId], plan: {}, createdAt: 1,
  });
  if (withConfirmedExperience) {
    await db.insert(profileExperiences).values({
      id: crypto.randomUUID(), materialId, type: "research", title: "Super-LoRa",
      background: "提升 LoRa 吞吐量", responsibilities: "负责 SDR 与算法验证",
      methods: "并行干扰消除", results: "吞吐量提升 1.35 倍", awardRole: "负责人",
      source: "resume.pdf", page: 2, evidence: { title: "Super-LoRa" }, confidence: 0.93,
      status: "confirmed", createdAt: 1, updatedAt: 1,
    });
  }
  return interviewId;
}

async function seedControl(interviewId: string, control: QuestionControl) {
  await db.insert(interviewEvents).values({
    id: crypto.randomUUID(),
    interviewId,
    type: "question_control",
    payload: control,
    createdAt: 2,
  });
}

function request(interviewId: string) {
  return new Request("http://localhost/api/realtime/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ interviewId }),
  });
}

describe("POST realtime session route", () => {
  it("returns a research instruction naming the confirmed Super-LoRa card for the requested interview", async () => {
    const interviewId = await createInterviewFixture(true);

    const response = await POST(request(interviewId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.websocketPath).toContain("/realtime?token=");
    expect(body.roleInstructions.research).toContain("Super-LoRa");
    expect(body.roleInstructions.research).toContain("第一问必须点名这项经历");
  });

  it("returns no research override when the selected material has no confirmed card", async () => {
    const interviewId = await createInterviewFixture(false);

    const response = await POST(request(interviewId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.roleInstructions).toEqual({});
  });

  it("returns the interview duration and saved question controls", async () => {
    const interviewId = await createInterviewFixture(false);
    const control: QuestionControl = {
      role: "english",
      kind: "new_topic",
      topicId: "english-hometown",
      topicCategory: "personal",
      questionId: "english-hometown",
      questionText: "Introduce your hometown briefly.",
      followUpDepth: 0,
      issuedAtMs: 1_020_000,
    };
    await seedControl(interviewId, control);

    const response = await POST(request(interviewId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.duration).toBe(20);
    expect(body.questionControls).toEqual([control]);
  });

  it("returns the latest persisted control as pending when it has no delivery or interviewer transcript", async () => {
    const interviewId = await createInterviewFixture(false);
    const controlId = "00000000-0000-4000-8000-000000000301";
    const control: QuestionControl = {
      role: "english",
      kind: "new_topic",
      topicId: "english-hometown",
      topicCategory: "personal",
      questionId: "english-hometown",
      questionText: "Introduce your hometown briefly.",
      followUpDepth: 0,
      issuedAtMs: 100,
    };
    await db.insert(interviewEvents).values({
      id: controlId,
      interviewId,
      type: "question_control",
      payload: control,
      createdAt: 100,
    });

    const response = await POST(request(interviewId));
    const body = await response.json();

    expect(body.pendingControl).toEqual({ id: controlId, control });
  });

  it.each(["question_delivery", "transcript"])(
    "does not return an already delivered control when a later %s exists",
    async (confirmationType) => {
      const interviewId = await createInterviewFixture(false);
      const controlId = crypto.randomUUID();
      const control: QuestionControl = {
        role: "technical",
        kind: "new_topic",
        topicId: "signals",
        topicCategory: "signals",
        followUpDepth: 0,
        issuedAtMs: 100,
      };
      await db.insert(interviewEvents).values([
        {
          id: controlId,
          interviewId,
          type: "question_control",
          payload: control,
          createdAt: 100,
        },
        confirmationType === "question_delivery"
          ? {
            id: crypto.randomUUID(),
            interviewId,
            type: "question_delivery",
            payload: { controlId, deliveredAtMs: 101 },
            createdAt: 101,
          }
          : {
            id: crypto.randomUUID(),
            interviewId,
            type: "transcript",
            payload: {
              role: "technical",
              startedAtMs: 101,
              endedAtMs: 101,
              text: "What is the sampling theorem?",
              confidence: 1,
              interrupted: false,
            },
            createdAt: 101,
          },
      ]);

      const response = await POST(request(interviewId));
      const body = await response.json();

      expect(body.pendingControl).toBeUndefined();
    },
  );
});
