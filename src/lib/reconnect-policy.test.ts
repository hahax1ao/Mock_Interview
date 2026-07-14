import { describe, expect, it } from "vitest";
import { reconnectDecision } from "./reconnect-policy";

describe("realtime reconnect policy", () => {
  it("retries transient disconnects but falls back after three failures", () => {
    expect(reconnectDecision(1)).toEqual({ retry: true, delayMs: 1500 });
    expect(reconnectDecision(2)).toEqual({ retry: true, delayMs: 3000 });
    expect(reconnectDecision(3)).toEqual({ retry: false, delayMs: 0 });
  });
});
