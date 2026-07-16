import { describe, expect, it } from "vitest";
import {
  decideNextQuestion,
  rebuildCoverageState,
  topicTargetsForDuration,
} from "./question-coverage";

describe("question coverage", () => {
  it.each([
    [10, 1],
    [20, 2],
    [30, 3],
  ] as const)("assigns %i-minute interviews a target of %i per core role", (duration, target) => {
    expect(topicTargetsForDuration(duration)).toEqual({
      technical: target,
      research: target,
      english: target,
    });
  });

  it("starts a different English category for the second required topic", () => {
    const first = decideNextQuestion({
      duration: 20,
      role: "english",
      elapsedMs: 0,
      moduleRemainingMs: 180_000,
      controls: [],
    });
    const second = decideNextQuestion({
      duration: 20,
      role: "english",
      elapsedMs: 0,
      moduleRemainingMs: 120_000,
      controls: [first],
    });
    expect(first.kind).toBe("new_topic");
    expect(second.kind).toBe("new_topic");
    expect(second.questionId).not.toBe(first.questionId);
    expect(second.topicCategory).not.toBe(first.topicCategory);
  });

  it("allows no more than three follow-ups after required coverage is complete", () => {
    const controls = [
      { role: "technical", kind: "new_topic", topicId: "signals", topicCategory: "signals", followUpDepth: 0, issuedAtMs: 1 },
      { role: "technical", kind: "follow_up", topicId: "signals", topicCategory: "signals", followUpDepth: 1, issuedAtMs: 2 },
      { role: "technical", kind: "follow_up", topicId: "signals", topicCategory: "signals", followUpDepth: 2, issuedAtMs: 3 },
      { role: "technical", kind: "follow_up", topicId: "signals", topicCategory: "signals", followUpDepth: 3, issuedAtMs: 4 },
    ] as const;
    const next = decideNextQuestion({
      duration: 10,
      role: "technical",
      elapsedMs: 0,
      moduleRemainingMs: 60_000,
      controls: [...controls],
    });
    expect(next.kind).toBe("new_topic");
    expect(next.topicId).not.toBe("signals");
  });

  it("returns the chair closing decision during the final minute", () => {
    const next = decideNextQuestion({
      duration: 10,
      role: "english",
      elapsedMs: 9 * 60_000,
      moduleRemainingMs: 30_000,
      controls: [],
    });
    expect(next.role).toBe("chair");
    expect(next.kind).toBe("closing");
  });

  it("rebuilds used English ids and topic counts from controls", () => {
    const state = rebuildCoverageState([
      {
        role: "english",
        kind: "new_topic",
        topicId: "english-hometown",
        topicCategory: "personal",
        questionId: "english-hometown",
        questionText: "Introduce your hometown briefly.",
        followUpDepth: 0,
        issuedAtMs: 1,
      },
    ]);
    expect(state.topicCounts.english).toBe(1);
    expect(state.usedEnglishQuestionIds).toEqual(["english-hometown"]);
  });
});
