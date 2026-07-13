import { describe, expect, it } from "vitest";
import { aggregateReview, scoreLevel } from "./scoring";

const evidence = {
  question: "解释采样定理。",
  answer: "采样频率应大于最高频率的两倍。",
  issueType: "knowledge" as const,
  explanation: "回答给出了核心条件。",
  suggestion: "补充频谱混叠的解释。",
  source: "信号与系统笔记第3页",
  confidence: 0.92,
};

describe("scoreLevel", () => {
  it.each([
    [39, "严重不足"],
    [40, "待加强"],
    [60, "合格"],
    [75, "良好"],
    [90, "优秀"],
  ] as const)("maps %i to %s", (score, level) => {
    expect(scoreLevel(score)).toBe(level);
  });

});

describe("aggregateReview", () => {
  it("uses the median, flags a 20-point disagreement, and calculates weighted total", () => {
    const report = aggregateReview([
      { reviewer: "chair", dimension: "technical", score: 60, evidence: [evidence] },
      { reviewer: "technical", dimension: "technical", score: 80, evidence: [evidence] },
      { reviewer: "chair", dimension: "research", score: 80, evidence: [evidence] },
      { reviewer: "research", dimension: "research", score: 80, evidence: [evidence] },
      { reviewer: "chair", dimension: "logic", score: 80, evidence: [evidence] },
      { reviewer: "english", dimension: "english", score: 80, evidence: [evidence] },
      { reviewer: "chair", dimension: "authenticity", score: 80, evidence: [evidence] },
      { reviewer: "chair", dimension: "pressure", score: 80, evidence: [evidence] },
    ]);

    expect(report.dimensions.find((item) => item.dimension === "technical")?.score).toBe(70);
    expect(report.disagreements).toHaveLength(1);
    expect(report.totalScore).toBe(78);
  });

  it("rejects score entries without evidence", () => {
    expect(() => aggregateReview([
      { reviewer: "chair", dimension: "technical", score: 70, evidence: [] },
    ])).toThrow(/证据/);
  });
  it("keeps missing dimensions unknown instead of treating them as zero", () => {
    const report = aggregateReview([
      { reviewer: "technical", dimension: "technical", score: 80, evidence: [evidence] },
    ]);

    expect(report.dimensions.find((item) => item.dimension === "research")?.score).toBeNull();
    expect(report.totalScore).toBeNull();
    expect(report.level).toBeNull();
  });
});
