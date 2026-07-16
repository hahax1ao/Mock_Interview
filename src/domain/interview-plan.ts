import { topicTargetsForDuration, type CoreInterviewRole } from "./question-coverage";

export type InterviewRole = "chair" | "technical" | "research" | "english" | "candidate";

export interface InterviewSegment {
  role: Exclude<InterviewRole, "candidate">;
  minutes: number;
  label: string;
  topicTarget?: number;
}

const templates: Record<10 | 20 | 30, number[]> = {
  10: [1, 2, 3, 2, 2],
  20: [2, 5, 6, 4, 3],
  30: [3, 8, 9, 6, 4],
};

const roles: InterviewSegment["role"][] = ["chair", "technical", "research", "english", "chair"];
const labels = ["开场", "专业基础", "科研项目", "英语交流", "综合与收尾"];

export function createInterviewPlan(duration: 10 | 20 | 30): InterviewSegment[] {
  const targets = topicTargetsForDuration(duration);
  return templates[duration].map((minutes, index) => {
    const role = roles[index];
    if (role === "technical" || role === "research" || role === "english") {
      return { role, minutes, label: labels[index], topicTarget: targets[role] };
    }
    return { role, minutes, label: labels[index] };
  });
}

export function remainingMsForRole(
  duration: 10 | 20 | 30,
  role: CoreInterviewRole,
  elapsedMs: number,
) {
  let segmentStartMs = 0;
  for (const segment of createInterviewPlan(duration)) {
    const segmentEndMs = segmentStartMs + segment.minutes * 60_000;
    if (segment.role === role) {
      return elapsedMs >= segmentStartMs && elapsedMs < segmentEndMs
        ? segmentEndMs - elapsedMs
        : 0;
    }
    segmentStartMs = segmentEndMs;
  }
  return 0;
}

export class InterviewClock {
  readonly durationMs: number;
  readonly plan: InterviewSegment[];
  elapsedMs = 0;
  private paused = false;
  private followUps = new Map<string, number>();

  constructor(duration: 10 | 20 | 30, _startedAt = Date.now()) {
    this.durationMs = duration * 60_000;
    this.plan = createInterviewPlan(duration);
  }

  tick(deltaMs: number) {
    if (!this.paused) this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + Math.max(0, deltaMs));
    return this.elapsedMs;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  get isPaused() { return this.paused; }
  get remainingMs() { return Math.max(0, this.durationMs - this.elapsedMs); }
  get isClosing() { return this.remainingMs <= 60_000; }

  get currentRole(): InterviewSegment["role"] {
    if (this.isClosing) return "chair";
    let boundary = 0;
    for (const segment of this.plan) {
      boundary += segment.minutes * 60_000;
      if (this.elapsedMs < boundary) return segment.role;
    }
    return "chair";
  }

  registerFollowUp(topic: string) {
    const count = this.followUps.get(topic) ?? 0;
    if (count >= 3) return false;
    this.followUps.set(topic, count + 1);
    return true;
  }
}
