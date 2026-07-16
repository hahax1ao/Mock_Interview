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

function sessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      websocketPath: "/realtime?token=test",
      duration: 20,
      questionControls: [],
      roleInstructions: {},
      ...overrides,
    }),
  };
}

function sentMessages(socket: FakeWebSocket) {
  return socket.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
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

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

    const instructions = ws.send.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .filter((payload) => payload.type === "response.create")
      .map((payload) => payload.response.instructions);
    expect(instructions.at(-1)).toContain(researchInstruction);
    act(() => root.unmount());
  });

  it("uses the exact selected safe English question on timed handoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/realtime/session") return sessionResponse();
      return { ok: true, json: async () => ({ saved: 1 }) };
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    const onElapsed = vi.fn().mockReturnValue("english");
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

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    const controlRequest = fetchMock.mock.calls
      .map(([, init]) => init)
      .find((init) => init && JSON.parse(String(init.body)).events?.[0]?.type === "question_control");
    const control = JSON.parse(String(controlRequest?.body)).events[0].payload;
    const instruction = sentMessages(ws)
      .filter((message) => message.type === "response.create")
      .at(-1).response.instructions;
    expect(control).toMatchObject({
      role: "english",
      kind: "new_topic",
      questionId: expect.any(String),
      questionText: expect.any(String),
    });
    expect(instruction).toContain(control.questionText);
    expect(instruction).toContain("不得改成专业、论文、项目或技术问题");
    act(() => root.unmount());
  });

  it("persists the next control after a candidate transcript before requesting the question", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/realtime/session") return sessionResponse();

      const events = JSON.parse(String(init?.body)).events;
      if (events.some((event: { type: string }) => event.type === "question_control")) {
        order.push("control-saved");
      }
      return { ok: true, json: async () => ({ saved: events.length }) };
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    let interview: ReturnType<typeof useRealtimeInterview> | null = null;
    function Harness() {
      interview = useRealtimeInterview("interview-1", () => "technical");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => interview!.connect());
    const ws = FakeWebSocket.instance!;
    ws.send.mockImplementation((payload) => {
      if (JSON.parse(String(payload)).type === "response.create") order.push("question-sent");
    });
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "session.updated" }) } as MessageEvent));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await vi.waitFor(() => expect(order).toContain("question-sent"));
    order.length = 0;

    act(() => ws.onmessage?.({
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "My answer is complete.",
      }),
    } as MessageEvent));
    await vi.waitFor(() => expect(order).toContain("question-sent"));

    const controlRequest = fetchMock.mock.calls
      .map(([, init]) => init)
      .findLast((init) => init && JSON.parse(String(init.body)).events
        ?.some((event: { type: string }) => event.type === "question_control"));
    expect(JSON.parse(String(controlRequest?.body))).toMatchObject({
      events: [{
        type: "question_control",
        payload: {
          role: "technical",
          kind: "new_topic",
          topicId: "communications",
          followUpDepth: 0,
        },
      }],
    });
    expect(order.indexOf("control-saved")).toBeLessThan(order.indexOf("question-sent"));
    act(() => root.unmount());
  });
  it("defers a timed handoff until the candidate transcript is complete", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/realtime/session") return sessionResponse();
      return { ok: true, json: async () => ({ saved: 1 }) };
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    let interview: ReturnType<typeof useRealtimeInterview> | null = null;
    function Harness() {
      interview = useRealtimeInterview("interview-1", () => "technical");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => interview!.connect());
    const ws = FakeWebSocket.instance!;
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "session.updated" }) } as MessageEvent));
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) } as MessageEvent));
    ws.send.mockClear();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(sentMessages(ws).filter((message) => message.type === "response.create")).toHaveLength(0);
    act(() => ws.onmessage?.({
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "I have finished answering.",
      }),
    } as MessageEvent));
    await vi.waitFor(() => expect(sentMessages(ws)
      .some((message) => message.type === "response.create")).toBe(true));
    act(() => root.unmount());
  });
});
