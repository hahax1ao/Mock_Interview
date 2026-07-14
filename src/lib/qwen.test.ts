import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { create } = vi.hoisted(() => ({
  create: vi.fn(async (_body: unknown, _options?: unknown) => ({
    choices: [{ message: { content: '{"ok":true}' } }],
  })),
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    chat = { completions: { create } };
  },
}));

import { qwenJson } from "./qwen";

describe("qwenJson", () => {
  beforeEach(() => {
    create.mockClear();
    process.env.DASHSCOPE_API_KEY = "test-key";
  });

  it("passes an optional per-call timeout to the OpenAI request options", async () => {
    await qwenJson({
      model: "test-model",
      system: "Return JSON",
      user: "Input",
      schema: z.object({ ok: z.boolean() }),
      timeoutMs: 120_000,
    } as Parameters<typeof qwenJson>[0] & { timeoutMs: number });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toEqual({ timeout: 120_000 });
  });
});
