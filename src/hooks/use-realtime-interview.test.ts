// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useRealtimeInterview } from "./use-realtime-interview";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static OPEN = 1;
  static instance: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { FakeWebSocket.instance = this; }
  send = vi.fn();
  close() {}
}

class FakeAudioContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource() { return { connect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instance = null;
  vi.useRealTimers();
});

describe("realtime connection setup", () => {
  it("subscribes to server events before microphone permission settles", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ websocketPath: "/realtime?token=test" }),
    }));
    const pendingPermission = new Promise<MediaStream>(() => undefined);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(() => pendingPermission) },
    });
    let interview: ReturnType<typeof useRealtimeInterview> | null = null;
    function Harness() {
      interview = useRealtimeInterview("interview-1", () => "chair");
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(React.createElement(Harness)); });

    act(() => { void interview!.connect(); });
    await vi.waitFor(() => expect(FakeWebSocket.instance).not.toBeNull());

    expect(FakeWebSocket.instance?.onmessage).toBeTypeOf("function");
    act(() => root.unmount());
  });

  it("appends the research core-experience requirement on timed handoff", async () => {
    vi.useFakeTimers();
    const researchInstruction = "核心经历：高吞吐量通信协议研究。第一问必须点名该经历并询问个人职责。";
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ websocketPath: "/realtime?token=test", roleInstructions: { research: researchInstruction } }),
    }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    const onElapsed = vi.fn().mockReturnValueOnce("technical").mockReturnValue("research");
    let interview: ReturnType<typeof useRealtimeInterview> | null = null;
    function Harness() {
      interview = useRealtimeInterview("interview-1", onElapsed);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => interview!.connect());
    const ws = FakeWebSocket.instance!;
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "session.updated" }) } as MessageEvent));

    act(() => vi.advanceTimersByTime(2_000));

    const instructions = ws.send.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .filter((payload) => payload.type === "response.create")
      .map((payload) => payload.response.instructions);
    expect(instructions.at(-1)).toContain(researchInstruction);
    act(() => root.unmount());
  });
});
