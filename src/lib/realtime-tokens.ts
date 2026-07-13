import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const consumed = new Set<string>();

function secret() {
  const value = process.env.REALTIME_TOKEN_SECRET ?? process.env.ALIYUN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!value || value.includes("your-key")) throw new Error("百炼 API Key 尚未配置");
  return value;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueRealtimeToken(interviewId: string) {
  const expiresAt = Date.now() + 5 * 60_000;
  const payload = Buffer.from(JSON.stringify({ interviewId, expiresAt, nonce: randomBytes(12).toString("base64url") })).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  return { token, expiresAt };
}

export function consumeRealtimeToken(token: string) {
  if (consumed.has(token)) return null;
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return null;
  const expected = sign(payload);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const record = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { interviewId: string; expiresAt: number };
  if (record.expiresAt < Date.now()) return null;
  consumed.add(token);
  return record;
}