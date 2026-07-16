import { describe, expect, it } from "vitest";
import { InterviewEventSchema, ReviewEntrySchema } from "./schemas";

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
