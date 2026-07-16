import { describe, expect, it } from "vitest";
import { InterviewEventSchema, QuestionControlSchema, ReviewEntrySchema } from "./schemas";

describe("interview event validation", () => {
  it("accepts a validated question-control event", () => {
    expect(InterviewEventSchema.parse({
      type: "question_control",
      payload: {
        role: "english",
        kind: "new_topic",
        topicId: "english-hometown",
        topicCategory: "personal",
        questionId: "english-hometown",
        questionText: "Introduce your hometown briefly.",
        followUpDepth: 0,
        issuedAtMs: 1000,
      },
    }).type).toBe("question_control");
  });

  it.each([
    { role: "technical", kind: "closing", topicId: "closing", topicCategory: "closing", followUpDepth: 0, issuedAtMs: 1 },
    { role: "chair", kind: "new_topic", topicId: "chair", topicCategory: "chair", followUpDepth: 0, issuedAtMs: 1 },
    { role: "english", kind: "new_topic", topicId: "english-hometown", topicCategory: "personal", followUpDepth: 0, issuedAtMs: 1 },
    {
      role: "english", kind: "follow_up", topicId: "english-hometown", topicCategory: "personal",
      questionId: "english-hometown", questionText: "Introduce your hometown briefly.", followUpDepth: 0, issuedAtMs: 1,
    },
    { role: "technical", kind: "new_topic", topicId: "signals", topicCategory: "signals", followUpDepth: 1, issuedAtMs: 1 },
  ])("rejects invalid question-control role, kind, and depth combinations", (control) => {
    expect(QuestionControlSchema.safeParse(control).success).toBe(false);
  });

  it("accepts a depth-three non-chair follow-up", () => {
    expect(QuestionControlSchema.safeParse({
      role: "technical", kind: "follow_up", topicId: "signals", topicCategory: "signals",
      followUpDepth: 3, issuedAtMs: 1,
    }).success).toBe(true);
  });

  it("accepts a validated question-delivery event", () => {
    expect(InterviewEventSchema.parse({
      type: "question_delivery",
      payload: {
        controlId: "00000000-0000-4000-8000-000000000301",
        deliveredAtMs: 101,
      },
    }).type).toBe("question_delivery");
  });
});

describe("review output normalization", () => {
  it("normalizes common Chinese enum labels from model output", () => {
    const parsed = ReviewEntrySchema.parse({
      reviewer: "专业基础老师",
      dimension: "专业基础",
      score: 82,
      evidence: [{
        question: "解释采样定理",
        answer: "采样频率应大于最高频率两倍",
        issueType: "专业知识",
        explanation: "核心条件正确",
        suggestion: "补充混叠解释",
        source: "模型复核",
        confidence: 0.7,
      }],
    });

    expect(parsed.reviewer).toBe("technical");
    expect(parsed.dimension).toBe("technical");
    expect(parsed.evidence[0].issueType).toBe("knowledge");
  });
});
