export const models = {
  realtime: process.env.QWEN_REALTIME_MODEL ?? "qwen3.5-omni-flash-realtime",
  technicalReview: process.env.QWEN_TECHNICAL_MODEL ?? process.env.QWEN_ECONOMY_MODEL ?? "qwen3.5-flash",
  researchReview: process.env.QWEN_TECHNICAL_MODEL ?? process.env.QWEN_ECONOMY_MODEL ?? "qwen3.5-flash",
  englishReview: process.env.QWEN_ECONOMY_MODEL ?? "qwen3.5-flash",
  expressionReview: process.env.QWEN_ECONOMY_MODEL ?? "qwen3.5-flash",
  synthesis: process.env.QWEN_SYNTHESIS_MODEL ?? process.env.QWEN_ECONOMY_MODEL ?? "qwen3.5-flash",
} as const;