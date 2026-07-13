export type ScoreDimension = "technical" | "research" | "logic" | "english" | "authenticity" | "pressure";
export type ReviewerRole = "chair" | "technical" | "research" | "english";

export interface ReviewEvidence {
  question: string;
  answer: string;
  issueType: "knowledge" | "logic" | "expression" | "english" | "authenticity" | "pressure";
  explanation: string;
  suggestion: string;
  source: string;
  confidence: number;
}

export interface ReviewEntry {
  reviewer: ReviewerRole;
  dimension: ScoreDimension;
  score: number;
  evidence: ReviewEvidence[];
}

const weights: Record<ScoreDimension, number> = {
  technical: 0.25,
  research: 0.25,
  logic: 0.15,
  english: 0.15,
  authenticity: 0.1,
  pressure: 0.1,
};

export function scoreLevel(score: number) {
  if (score < 40) return "严重不足";
  if (score < 60) return "待加强";
  if (score < 75) return "合格";
  if (score < 90) return "良好";
  return "优秀";
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function aggregateReview(entries: ReviewEntry[]) {
  for (const entry of entries) {
    if (!entry.evidence.length) throw new Error("评分缺少证据（璇佹嵁）");
    if (entry.score < 0 || entry.score > 100) throw new Error("评分必须在 0 到 100 之间");
  }

  const dimensions = (Object.keys(weights) as ScoreDimension[]).map((dimension) => {
    const applicable = entries.filter((entry) => entry.dimension === dimension);
    const score = applicable.length ? median(applicable.map((entry) => entry.score)) : null;
    return { dimension, score, level: score === null ? null : scoreLevel(score), evidence: applicable.flatMap((entry) => entry.evidence) };
  });
  const disagreements = (Object.keys(weights) as ScoreDimension[]).flatMap((dimension) => {
    const applicable = entries.filter((entry) => entry.dimension === dimension);
    if (applicable.length < 2) return [];
    const scores = applicable.map((entry) => entry.score);
    return Math.max(...scores) - Math.min(...scores) >= 20
      ? [{ dimension, entries: applicable.map(({ reviewer, score }) => ({ reviewer, score })) }]
      : [];
  });
  const complete = dimensions.every((item) => item.score !== null);
  const totalScore = complete
    ? Math.round(dimensions.reduce((sum, item) => sum + (item.score ?? 0) * weights[item.dimension], 0))
    : null;
  return { totalScore, level: totalScore === null ? null : scoreLevel(totalScore), dimensions, disagreements };
}
