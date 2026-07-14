export function reconnectDecision(attempt: number, maximumAttempts = 3) {
  if (attempt >= maximumAttempts) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: 1500 * Math.max(1, attempt) };
}
