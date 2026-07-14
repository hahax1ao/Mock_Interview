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

function mountInterview() {
  let interview: ReturnType<typeof useRealtimeInterview> | null = null;
  function Harness() {
    interview = useRealtimeInterview("interview-1", () => "chair");
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
});
