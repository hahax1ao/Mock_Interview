import OpenAI from "openai";
import { z } from "zod";

let singleton: OpenAI | undefined;

function apiKey() {
  return process.env.ALIYUN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
}

export function isQwenConfigured() {
  const key = apiKey();
  return Boolean(key && !key.includes("your-key"));
}

export function qwenClient() {
  if (!isQwenConfigured()) throw new Error("请配置 ALIYUN_API_KEY 或 DASHSCOPE_API_KEY");
  singleton ??= new OpenAI({
    apiKey: apiKey(),
    baseURL: process.env.QWEN_TEXT_BASE_URL ?? process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    timeout: Number(process.env.QWEN_REQUEST_TIMEOUT_MS ?? 60_000),
    maxRetries: 0,
  });
  return singleton;
}

export async function qwenJson<T>(options: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean;
  timeoutMs?: number;
}) {
  const requestBody = {
    model: options.model,
    temperature: options.temperature ?? 0.2,
    messages: [
      { role: "system", content: options.system + "\n仅输出合法 JSON，不要使用 Markdown 代码块。" },
      { role: "user", content: options.user },
    ],
    response_format: { type: "json_object" },
    max_tokens: options.maxTokens ?? 1_800,
    extra_body: { enable_thinking: options.enableThinking ?? false },
  };
  const requestOptions = options.timeoutMs === undefined
    ? undefined
    : { timeout: options.timeoutMs };
  const response = await qwenClient().chat.completions.create(requestBody as any, requestOptions);
  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("百炼返回了空响应");
  return options.schema.parse(JSON.parse(raw));
}