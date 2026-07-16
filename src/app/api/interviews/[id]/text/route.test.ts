import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews } from "@/db/schema";
import { englishQuestionBank } from "@/domain/english-question-bank";
import type { QuestionControl } from "@/domain/question-coverage";

const { createCompletion, buildResearchHandoffInstruction, buildInterviewContext } = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  buildResearchHandoffInstruction: vi.fn(async () => "FIRST_RESEARCH_PROJECT_QUESTION"),
  buildInterviewContext: vi.fn(async () => "CONFIRMED SUPER-LORA PROJECT CONTEXT"),
}));

vi.mock("@/lib/qwen", () => ({
  qwenClient: () => ({ chat: { completions: { create: createCompletion } } }),
}));
vi.mock("@/lib/experience-interview", () => ({ buildResearchHandoffInstruction }));
vi.mock("@/lib/interview-context", () => ({ buildInterviewContext }));

import { POST } from "./route";

const interviewIds: string[] = [];

async function createInterview(duration: 10 | 20 | 30 = 20) {
  await initDatabase();
  const id = crypto.randomUUID();
  interviewIds.push(id);
  await db.insert(interviews).values({
    id, status: "active", duration, focus: "communications", pressure: "adaptive",
    materialIds: [], plan: {}, startedAt: 1, createdAt: 1,
  });
  return id;
}

async function postText(
  id: string,
  input: { text: string; role: "chair" | "technical" | "research" | "english"; atMs: number },
) {
  return POST(new Request(`http://localhost/api/interviews/${id}/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }), { params: Promise.resolve({ id }) });
}

async function postResearch(id: string) {
  return postText(id, { text: "candidate answer", role: "research", atMs: 100 });
}

async function seedControl(id: string, control: QuestionControl) {
  await db.insert(interviewEvents).values({
    id: crypto.randomUUID(),
    interviewId: id,
    type: "question_control",
    payload: control,
    createdAt: control.issuedAtMs,
  });
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

  it("serializes concurrent first research posts so only one receives the initial instruction", async () => {
    const id = await createInterview(10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    createCompletion.mockImplementation(async () => {
      await gate;
      return { choices: [{ message: { content: "next question" } }] };
    });

    const first = postResearch(id);
    const second = postResearch(id);
    await vi.waitFor(() => expect(createCompletion).toHaveBeenCalled());
    release();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const initialInstructions = createCompletion.mock.calls.filter((call) =>
      call[0].messages[0].content.includes("FIRST_RESEARCH_PROJECT_QUESTION"),
    );
    expect(initialInstructions).toHaveLength(1);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.filter(({ control }) => control.kind === "new_topic")).toHaveLength(1);
    expect(bodies.filter(({ control }) => control.kind === "follow_up")).toHaveLength(1);
    const claims = await db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, id));
    expect(claims).toContainEqual(expect.objectContaining({
      type: "research_initial_claim",
      payload: { status: "completed", leaseUntil: null },
    }));
    const researchControls = claims.filter(({ type, payload }) =>
      type === "question_control"
      && payload && typeof payload === "object"
      && "role" in payload && payload.role === "research",
    );
    expect(researchControls).toHaveLength(2);
    expect(researchControls.filter(({ payload }) =>
      payload && typeof payload === "object" && "kind" in payload && payload.kind === "new_topic",
    )).toHaveLength(1);
  });

  it("releases a failed initial claim so retry receives the initial instruction", async () => {
    const id = await createInterview();
    createCompletion
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "retry question" } }] });

    const failed = await postResearch(id);
    const afterFailure = await db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, id));
    const retried = await postResearch(id);

    expect(failed.status).toBe(400);
    expect(afterFailure).not.toContainEqual(expect.objectContaining({ type: "research_initial_claim" }));
    expect(retried.status).toBe(200);
    expect(createCompletion.mock.calls[1][0].messages[0].content).toContain("FIRST_RESEARCH_PROJECT_QUESTION");
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

describe("POST text interview scheduled questions", () => {
  it("returns the exact safe bank question for an English new topic", async () => {
    const id = await createInterview();

    const response = await postText(id, {
      role: "english",
      text: "My answer",
      atMs: 100,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.control.role).toBe("english");
    expect(body.control.kind).toBe("new_topic");
    expect(body.reply).toBe(body.control.questionText);
    expect(englishQuestionBank.map(({ text }) => text)).toContain(body.reply);
    expect(createCompletion).not.toHaveBeenCalled();
    expect(buildInterviewContext).not.toHaveBeenCalled();
    expect(buildResearchHandoffInstruction).not.toHaveBeenCalled();
  });

  it("does not include detailed project context in the English system message", async () => {
    const id = await createInterview(10);
    await seedControl(id, {
      role: "english",
      kind: "new_topic",
      topicId: "english-hometown",
      topicCategory: "personal",
      questionId: "english-hometown",
      questionText: "Introduce your hometown briefly.",
      followUpDepth: 0,
      issuedAtMs: 50,
    });
    await db.insert(interviewEvents).values([
      {
        id: crypto.randomUUID(),
        interviewId: id,
        type: "transcript",
        payload: {
          role: "english",
          startedAtMs: 50,
          endedAtMs: 50,
          text: "Introduce your hometown briefly.",
          confidence: 1,
          interrupted: false,
        },
        createdAt: 50,
      },
      {
        id: crypto.randomUUID(),
        interviewId: id,
        type: "transcript",
        payload: {
          role: "research",
          startedAtMs: 60,
          endedAtMs: 60,
          text: "Tell me about Super-LoRa.",
          confidence: 1,
          interrupted: false,
        },
        createdAt: 60,
      },
    ]);
    createCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: "How did that experience make you feel?" } }],
    });

    const response = await postText(id, {
      role: "english",
      text: "It made me more confident.",
      atMs: 100,
    });

    expect(response.status).toBe(200);
    const request = createCompletion.mock.calls[0][0];
    expect(request.messages[0].content).toContain(
      "Ask one short English follow-up about feelings, personal growth, teamwork, motivation, planning, or daily communication.",
    );
    expect(request.messages[0].content).toContain(
      "Do not ask about courses, papers, projects, competitions, algorithms, experiments, or technical details.",
    );
    expect(JSON.stringify(request.messages)).not.toContain("SUPER-LORA");
    expect(JSON.stringify(request.messages)).not.toContain("Super-LoRa");
    expect(buildInterviewContext).not.toHaveBeenCalled();
  });

  it("retries an invalid English follow-up once and falls back to the next exact bank question", async () => {
    const id = await createInterview(10);
    await seedControl(id, {
      role: "english",
      kind: "new_topic",
      topicId: "english-hometown",
      topicCategory: "personal",
      questionId: "english-hometown",
      questionText: "Introduce your hometown briefly.",
      followUpDepth: 0,
      issuedAtMs: 50,
    });
    createCompletion
      .mockResolvedValueOnce({
        choices: [{ message: { content: "Which algorithm did your project use?" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "How did you feel? What did you learn?" } }],
      });

    const response = await postText(id, {
      role: "english",
      text: "I learned a lot.",
      atMs: 100,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(createCompletion).toHaveBeenCalledTimes(2);
    expect(createCompletion.mock.calls[1][0].temperature).toBe(0);
    expect(body.reply).toBe("Could you tell us something about your university?");
    expect(body.control.questionText).toBe(body.reply);
    expect(body.control.kind).toBe("new_topic");
    expect(englishQuestionBank.map(({ text }) => text)).toContain(body.reply);
  });

  it("uses a short chair prompt for a closing decision", async () => {
    const id = await createInterview(10);
    createCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: "Do you have any final remarks?" } }],
    });

    const response = await postText(id, {
      role: "english",
      text: "That is all.",
      atMs: 9 * 60_000,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      reply: "Do you have any final remarks?",
      control: expect.objectContaining({ role: "chair", kind: "closing" }),
    });
    expect(createCompletion.mock.calls[0][0].messages[0].content).toContain("当前角色：主考官");
    expect(createCompletion.mock.calls[0][0].messages[0].content).toContain("one short closing question");
    expect(buildInterviewContext).not.toHaveBeenCalled();
  });
  it("rolls back both transcripts when question control persistence fails", async () => {
    const id = await createInterview();
    const triggerName = `fail_question_control_${id.replaceAll("-", "_")}`;
    await db.run(sql.raw(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON interview_events
      WHEN NEW.interview_id = '${id}' AND NEW.type = 'question_control'
      BEGIN
        SELECT RAISE(ABORT, 'forced question control failure');
      END
    `));

    try {
      const response = await postText(id, {
        role: "english",
        text: "My answer",
        atMs: 100,
      });

      expect(response.status).toBe(400);
      const events = await db.select().from(interviewEvents)
        .where(eq(interviewEvents.interviewId, id));
      expect(events).toEqual([]);
    } finally {
      await db.run(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName}`));
    }
  });
  it("persists candidate, interviewer, and question control events together", async () => {
    const id = await createInterview();

    const response = await postText(id, {
      role: "english",
      text: "My answer",
      atMs: 100,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const events = await db.select().from(interviewEvents)
      .where(eq(interviewEvents.interviewId, id));
    expect(events.filter(({ type }) => type === "transcript")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "transcript",
      payload: expect.objectContaining({ role: "candidate", text: "My answer" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "transcript",
      payload: expect.objectContaining({ role: "english", text: body.reply }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "question_control",
      payload: body.control,
    }));
  });
});
