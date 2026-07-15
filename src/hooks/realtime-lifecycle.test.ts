// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRealtimeInterview } from "./use-realtime-interview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() { FakeWebSocket.instances.push(this); }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48_000;
  currentTime = 0;
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => ({ connect() {} }));
  createScriptProcessor = vi.fn(() => ({ connect() {}, disconnect() {}, onaudioprocess: null }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect() {} }));
  constructor() { FakeAudioContext.instances.push(this); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mountInterview(onElapsed: (delta: number) => "chair" | "technical" | "research" | "english" = () => "chair") {
  let interview: ReturnType<typeof useRealtimeInterview> | null = null;
  function Harness() {
    interview = useRealtimeInterview("interview-1", onElapsed);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(React.createElement(Harness)));
  return { get interview() { return interview!; }, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  FakeAudioContext.instances = [];
  vi.useRealTimers();
});

describe("realtime async lifecycle", () => {
  it("waits for microphone permission before opening and starting the interview", async () => {
    const permission = deferred<MediaStream>();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ websocketPath: "/realtime?token=test" }) }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => permission.promise) } });
    const mounted = mountInterview();
    let connection!: Promise<void>;
    act(() => { connection = mounted.interview.connect(); });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];

    act(() => socket.onmessage?.({ data: JSON.stringify({ type: "session.updated" }) } as MessageEvent));
    expect(socket.send).not.toHaveBeenCalled();

    await act(async () => {
      permission.resolve({ getTracks: () => [] } as unknown as MediaStream);
      await connection;
    });
    expect(mounted.interview.state).toBe("connected");
    act(() => mounted.root.unmount());
  });

  it("does not attach a late microphone result after disconnect", async () => {
    const permission = deferred<MediaStream>();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ websocketPath: "/realtime?token=test" }) }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => permission.promise) } });
    const mounted = mountInterview();
    let connection!: Promise<void>;
    act(() => { connection = mounted.interview.connect(); });
    await vi.waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1));

    await act(async () => mounted.interview.disconnect());
    permission.resolve({ getTracks: () => [] } as unknown as MediaStream);
    await act(async () => connection);

    expect(FakeAudioContext.instances[0].createMediaStreamSource).not.toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it("reuses the research core-experience requirement after reconnect", async () => {
    vi.useFakeTimers();
    const researchInstruction = "核心经历：高吞吐量通信协议研究。第一问必须询问个人职责。";
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    let sessionRequests = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/realtime/session") return { ok: true, json: async () => ({}) };
      sessionRequests += 1;
      return {
        ok: true,
        json: async () => sessionRequests === 1
          ? { websocketPath: "/realtime?token=test", roleInstructions: { research: researchInstruction } }
          : { websocketPath: "/realtime?token=test", roleInstructions: {} },
      };
    }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) } });
    const mounted = mountInterview(() => "research");
    await act(async () => mounted.interview.connect());
    const first = FakeWebSocket.instances[0];
    act(() => first.onmessage?.({ data: JSON.stringify({ type: "session.updated" }) } as MessageEvent));
    act(() => vi.advanceTimersByTime(1_000));

    act(() => first.onclose?.({ reason: "network" } as CloseEvent));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    const second = FakeWebSocket.instances[1];
    act(() => second.onmessage?.({ data: JSON.stringify({ type: "session.updated" }) } as MessageEvent));

    const instructions = second.send.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .find((payload) => payload.type === "response.create")?.response.instructions;
    expect(instructions).toContain(researchInstruction);
    act(() => mounted.root.unmount());
  });
});
