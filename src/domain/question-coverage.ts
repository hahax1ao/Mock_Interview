import {
  selectEnglishQuestion,
  type EnglishQuestionCategory,
} from "./english-question-bank";

export type CoreInterviewRole = "technical" | "research" | "english";
export type QuestionControl = {
  role: CoreInterviewRole | "chair";
  kind: "new_topic" | "follow_up" | "closing";
  topicId: string;
  topicCategory: string;
  questionId?: string;
  questionText?: string;
  followUpDepth: number;
  issuedAtMs: number;
};

export type CoverageState = {
  topicCounts: Record<CoreInterviewRole, number>;
  usedTopicIds: Record<CoreInterviewRole, string[]>;
  usedEnglishQuestionIds: string[];
  usedEnglishCategories: EnglishQuestionCategory[];
  current?: QuestionControl;
};

type DecideNextQuestionInput = {
  duration: 10 | 20 | 30;
  role: CoreInterviewRole;
  elapsedMs: number;
  moduleRemainingMs: number;
  controls: QuestionControl[];
};

const TARGETS = { 10: 1, 20: 2, 30: 3 } as const;
const TECHNICAL_TOPICS = [
  "signals",
  "communications",
  "digital",
  "analog",
  "circuits",
  "probability",
] as const;
const RESEARCH_TOPICS = [
  "responsibility",
  "method",
  "validation",
  "limitations",
  "teamwork",
  "planning",
] as const;

export function topicTargetsForDuration(duration: 10 | 20 | 30) {
  const target = TARGETS[duration];
  return { technical: target, research: target, english: target };
}

export function rebuildCoverageState(controls: QuestionControl[]): CoverageState {
  const identities = new Set<string>();
  const newTopics = controls.filter((control) => {
    if (control.kind !== "new_topic" || control.role === "chair") return false;
    const topicId = control.role === "english" ? (control.questionId ?? control.topicId) : control.topicId;
    const identity = `${control.role}:${topicId}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  const idsFor = (role: CoreInterviewRole) =>
    newTopics.filter((control) => control.role === role).map((control) =>
      role === "english" ? (control.questionId ?? control.topicId) : control.topicId,
    );
  const english = newTopics.filter((control) => control.role === "english");
  return {
    topicCounts: {
      technical: idsFor("technical").length,
      research: idsFor("research").length,
      english: idsFor("english").length,
    },
    usedTopicIds: {
      technical: idsFor("technical"),
      research: idsFor("research"),
      english: idsFor("english"),
    },
    usedEnglishQuestionIds: english.flatMap((control) =>
      control.questionId ? [control.questionId] : [],
    ),
    usedEnglishCategories: english.map(
      (control) => control.topicCategory as EnglishQuestionCategory,
    ),
    current: controls.at(-1),
  };
}

function createNewTopic(
  role: CoreInterviewRole,
  state: CoverageState,
  elapsedMs: number,
): QuestionControl | undefined {
  if (role === "english") {
    const question = selectEnglishQuestion(
      state.usedEnglishQuestionIds,
      state.usedEnglishCategories,
    );
    if (state.usedEnglishQuestionIds.includes(question.id)) return undefined;
    return {
      role,
      kind: "new_topic",
      topicId: question.id,
      topicCategory: question.category,
      questionId: question.id,
      questionText: question.text,
      followUpDepth: 0,
      issuedAtMs: elapsedMs,
    };
  }

  const topics = role === "technical" ? TECHNICAL_TOPICS : RESEARCH_TOPICS;
  const topicId = topics.find((topic) => !state.usedTopicIds[role].includes(topic));
  if (!topicId) return undefined;
  return {
    role,
    kind: "new_topic",
    topicId,
    topicCategory: topicId,
    followUpDepth: 0,
    issuedAtMs: elapsedMs,
  };
}

export function decideNextQuestion(input: DecideNextQuestionInput): QuestionControl {
  const { duration, role, elapsedMs, controls } = input;
  if (elapsedMs >= duration * 60_000 - 60_000) {
    return {
      role: "chair",
      kind: "closing",
      topicId: "closing",
      topicCategory: "closing",
      followUpDepth: 0,
      issuedAtMs: elapsedMs,
    };
  }

  const state = rebuildCoverageState(controls);
  const target = topicTargetsForDuration(duration)[role];
  const current = controls.findLast((control) => control.role === role);

  if (state.topicCounts[role] < target || !current || current.followUpDepth >= 3) {
    const newTopic = createNewTopic(role, state, elapsedMs);
    if (newTopic) return newTopic;
    if (!current) throw new Error(`No unused ${role} topics remain`);
    return {
      ...current,
      role,
      kind: "follow_up",
      followUpDepth: Math.min(3, Math.max(1, current.followUpDepth + 1)),
      issuedAtMs: elapsedMs,
    };
  }

  return {
    ...current,
    role,
    kind: "follow_up",
    followUpDepth: current.followUpDepth + 1,
    issuedAtMs: elapsedMs,
  };
}
