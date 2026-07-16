import { describe, expect, it } from "vitest";
import {
  InterviewClock,
  createInterviewPlan,
  remainingMsForRole,
} from "./interview-plan";

describe("createInterviewPlan", () => {
  it("allocates the confirmed 20-minute balanced schedule", () => {
    expect(createInterviewPlan(20).map(({ role, minutes }) => ({ role, minutes }))).toEqual([
      { role: "chair", minutes: 2 },
      { role: "technical", minutes: 5 },
      { role: "research", minutes: 6 },
      { role: "english", minutes: 4 },
      { role: "chair", minutes: 3 },
    ]);
  });

  it.each([10, 20, 30] as const)("allocates exactly %i minutes", (duration) => {
    const total = createInterviewPlan(duration).reduce((sum, segment) => sum + segment.minutes, 0);
    expect(total).toBe(duration);
  });

  it.each([
    [10, 1],
    [20, 2],
    [30, 3],
  ] as const)("exposes a %i-minute topic target of %i for each core segment", (duration, target) => {
    const core = createInterviewPlan(duration).filter((segment) =>
      ["technical", "research", "english"].includes(segment.role),
    );
    expect(core.map((segment) => segment.topicTarget)).toEqual([target, target, target]);
  });

  it("reports 120 seconds remaining in the 20-minute technical segment at minute 5", () => {
    expect(remainingMsForRole(20, "technical", 5 * 60_000)).toBe(120_000);
  });

  it("omits topic targets from chair segments", () => {
    const chairs = createInterviewPlan(20).filter((segment) => segment.role === "chair");
    expect(chairs.every((segment) => !("topicTarget" in segment))).toBe(true);
  });
});

describe("InterviewClock", () => {
  it("pauses without consuming interview time", () => {
    const clock = new InterviewClock(20, 0);
    clock.tick(60_000);
    clock.pause();
    clock.tick(120_000);
    clock.resume();
    clock.tick(60_000);
    expect(clock.elapsedMs).toBe(120_000);
  });

  it("forces the chair role for the final minute", () => {
    const clock = new InterviewClock(10, 0);
    clock.tick(9 * 60_000 + 1);
    expect(clock.currentRole).toBe("chair");
    expect(clock.isClosing).toBe(true);
  });

  it("allows no more than three follow-ups on one topic", () => {
    const clock = new InterviewClock(20, 0);
    expect(clock.registerFollowUp("signals")).toBe(true);
    expect(clock.registerFollowUp("signals")).toBe(true);
    expect(clock.registerFollowUp("signals")).toBe(true);
    expect(clock.registerFollowUp("signals")).toBe(false);
  });
});
