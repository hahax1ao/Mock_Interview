import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews } from "@/db/schema";

const { createCompletion, buildResearchHandoffInstruction, buildInterviewContext } = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  buildResearchHandoffInstruction: vi.fn(async () => "FIRST_RESEARCH_PROJECT_QUESTION"),
  buildInterviewContext: vi.fn(async () => "INTERVIEW_CONTEXT"),
}));

vi.mock("@/lib/qwen", () => ({
  qwenClient: () => ({ chat: { completions: { create: createCompletion } } }),
}));
vi.mock("@/lib/experience-interview", () => ({ buildResearchHandoffInstruction }));
vi.mock("@/lib/interview-context", () => ({ buildInterviewContext }));

import { POST } from "./route";

const interviewIds: string[] = [];

async function createInterview() {
  await initDatabase();
  const id = crypto.randomUUID();
  interviewIds.push(id);
  await db.insert(interviews).values({
    id, status: "active", duration: 20, focus: "communications", pressure: "adaptive",
    materialIds: [], plan: {}, startedAt: 1, createdAt: 1,
  });
  return id;
}

async function postResearch(id: string) {
  return POST(new Request(`http://localhost/api/interviews/${id}/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "candidate answer", role: "research", atMs: 100 }),
  }), { params: Promise.resolve({ id }) });
}

afterEach(async () => {
  await Promise.all(interviewIds.splice(0).map((id) => db.delete(interviews).where(eq(interviews.id, id))));
});

beforeEach(() => {
  createCompletion.mockReset();
  createCompletion.mockResolvedValue({ choices: [{ message: { content: "next question" } }] });
  buildResearchHandoffInstruction.mockClear();
  buildInterviewContext.mockClear();
});

describe("POST text interview research questions", () => {
  it("includes the fixed project instruction for the first research question after handoff", async () => {
    const id = await createInterview();
    await db.insert(interviewEvents).values({
      id: crypto.randomUUID(), interviewId: id, type: "handoff",
      payload: { from: "technical", to: "research", atMs: 90 }, createdAt: 90,
    });

    const response = await postResearch(id);

    expect(response.status).toBe(200);
    const request = createCompletion.mock.calls[0][0];
    expect(request.messages[0].content).toContain("FIRST_RESEARCH_PROJECT_QUESTION");
  });

  it("does not repeat the fixed project instruction on a research follow-up", async () => {
    const id = await createInterview();
    await db.insert(interviewEvents).values({
      id: crypto.randomUUID(), interviewId: id, type: "transcript",
      payload: { role: "research", startedAtMs: 50, endedAtMs: 60, text: "first project question", confidence: 1, interrupted: false },
      createdAt: 60,
    });

    const response = await postResearch(id);

    expect(response.status).toBe(200);
    const request = createCompletion.mock.calls[0][0];
    expect(request.messages[0].content).not.toContain("FIRST_RESEARCH_PROJECT_QUESTION");
    expect(buildResearchHandoffInstruction).not.toHaveBeenCalled();
  });
});
