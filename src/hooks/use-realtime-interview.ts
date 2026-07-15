"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseRealtimeServerEvent } from "@/lib/realtime-events";
import { reconnectDecision } from "@/lib/reconnect-policy";

type Role = "chair" | "technical" | "research" | "english";
type Transcript = { role: Role | "candidate"; text: string; atMs: number; interrupted?: boolean };
const ROLE_LABEL: Record<Role, string> = { chair: "主考官", technical: "专业基础老师", research: "科研项目导师", english: "英语老师" };

function floatToPcm16(input: Float32Array, inputRate: number, outputRate = 16000) {
  const ratio = inputRate / outputRate;
  const length = Math.round(input.length / ratio);
  const buffer = new ArrayBuffer(length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] ?? 0));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToFloat(data: string) {
  const binary = atob(data);
  const output = new Float32Array(binary.length / 2);
  for (let i = 0; i < output.length; i++) {
    const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    const signed = value > 32767 ? value - 65536 : value;
    output[i] = signed / 32768;
  }
  return output;
}

export function useRealtimeInterview(interviewId: string | null, onElapsed: (delta: number) => Role) {
  const [state, setState] = useState<"idle" | "connecting" | "connected" | "reconnecting" | "text">("idle");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [error, setError] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const processor = useRef<ScriptProcessorNode | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const sources = useRef(new Set<AudioBufferSourceNode>());
  const nextPlayAt = useRef(0);
  const elapsedMs = useRef(0);
  const lastRole = useRef<Role>("chair");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualClose = useRef(false);
  const sessionReady = useRef(false);
  const micAvailable = useRef(true);
  const eventQueue = useRef<unknown[]>([]);
  const drainPromise = useRef<Promise<void> | null>(null);
  const transcriptRef = useRef<Transcript[]>([]);
  const topicQuestionDepth = useRef(0);
  const reconnect = useRef<() => Promise<void>>(async () => undefined);
  const micPermissionSettled = useRef(false);
  const sessionStarted = useRef(false);
  const connectionGeneration = useRef(0);
  const reconnectAttempts = useRef(0);
  const roleInstructions = useRef<{ research?: string }>({});

  const drainEvents = useCallback(async () => {
    if (!interviewId) return;
    if (drainPromise.current) return drainPromise.current;
    const run = (async () => {
      while (eventQueue.current.length) {
        const batch = eventQueue.current.slice(0, 50);
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(`/api/interviews/${interviewId}/events`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ events: batch }),
            });
            if (!response.ok) throw new Error(`转写保存失败（${response.status}）`);
            lastError = null;
            break;
          } catch (reason) {
            lastError = reason instanceof Error ? reason : new Error("转写保存失败");
          }
        }
        if (lastError) throw lastError;
        eventQueue.current.splice(0, batch.length);
      }
    })();
    drainPromise.current = run;
    try { await run; } finally { drainPromise.current = null; }
  }, [interviewId]);

  const saveEvent = useCallback((event: unknown) => {
    const envelope = event && typeof event === "object"
      ? { id: crypto.randomUUID(), ...(event as Record<string, unknown>) }
      : event;
    eventQueue.current.push(envelope);
    void drainEvents().catch((reason) => setError(reason instanceof Error ? reason.message : "转写保存失败"));
  }, [drainEvents]);

  const flushEvents = useCallback(async () => {
    await drainEvents();
    if (eventQueue.current.length) throw new Error("仍有转写未保存，已阻止复盘；请检查本地服务后重试");
  }, [drainEvents]);

  const stopAudio = useCallback(() => {
    for (const source of sources.current) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    sources.current.clear();
    nextPlayAt.current = audio.current?.currentTime ?? 0;
  }, []);

  const playAudio = useCallback((encoded: string) => {
    const context = audio.current;
    if (!context) return;
    const samples = base64ToFloat(encoded);
    const buffer = context.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    sources.current.add(source);
    source.onended = () => sources.current.delete(source);
    const at = Math.max(context.currentTime + 0.03, nextPlayAt.current);
    source.start(at);
    nextPlayAt.current = at + buffer.duration;
  }, []);

  const persistTranscript = useCallback((role: Transcript["role"], text: string) => {
    const turn = { role, text, atMs: elapsedMs.current };
    transcriptRef.current.push(turn);
    if (role !== "candidate") topicQuestionDepth.current += 1;
    setTranscripts((items) => [...items, turn]);
    void saveEvent({ type: "transcript", payload: {
      role, startedAtMs: turn.atMs, endedAtMs: turn.atMs, text, confidence: 1, interrupted: false,
    } });
  }, [saveEvent]);

  const beginSession = useCallback(() => {
    if (sessionStarted.current || !sessionReady.current || !micPermissionSettled.current) return;
    sessionStarted.current = true;
    setState(micAvailable.current ? "connected" : "text");
    void saveEvent({ type: "connection", payload: { state: micAvailable.current ? "connected" : "text-fallback", atMs: elapsedMs.current } });
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const recent = transcriptRef.current.slice(-4).map((turn) => `${turn.role}: ${turn.text}`).join("\n");
      const roleInstruction = lastRole.current === "research" ? roleInstructions.current.research : undefined;
      const instructions = (elapsedMs.current === 0
        ? "你是主考官。现在正式开场，先简短问候，再只问一个自我介绍问题。"
        : `刚才连接中断。现在由【${ROLE_LABEL[lastRole.current]}】承接已有对话继续，只问一个问题。最近转写：\n${recent}`)
        + (roleInstruction ? `\n${roleInstruction}` : "");
      ws.send(JSON.stringify({ type: "response.create", response: { instructions } }));
    }
    if (!timer.current) timer.current = setInterval(() => {
      elapsedMs.current += 1000;
      const role = onElapsed(1000);
      const current = socket.current;
      if (role !== lastRole.current && current?.readyState === WebSocket.OPEN) {
        const previous = lastRole.current;
        lastRole.current = role;
        topicQuestionDepth.current = 0;
        stopAudio();
        current.send(JSON.stringify({ type: "response.cancel" }));
        const roleInstruction = role === "research" ? roleInstructions.current.research : undefined;
        current.send(JSON.stringify({ type: "response.create", response: { instructions: `立即停止当前模块。现在由【${ROLE_LABEL[role]}】继续面试，只问一个问题。${roleInstruction ? `\n${roleInstruction}` : ""}` } }));
        void saveEvent({ type: "handoff", payload: { from: previous, to: role, atMs: elapsedMs.current } });
      }
    }, 1000);
  }, [onElapsed, saveEvent, stopAudio]);

  const handleMessage = useCallback((event: MessageEvent) => {
    let raw: unknown;
    try { raw = JSON.parse(String(event.data)); } catch { return; }
    const parsed = parseRealtimeServerEvent(raw);
    if (parsed.kind === "audio") {
      reconnectAttempts.current = 0;
      playAudio(parsed.data);
    }
    if (parsed.kind === "transcript") {
      const role = parsed.speaker === "candidate" ? "candidate" : lastRole.current;
      persistTranscript(role, parsed.text);
      if (role === "candidate" && topicQuestionDepth.current >= 3 && socket.current?.readyState === WebSocket.OPEN) {
        topicQuestionDepth.current = 0;
        socket.current.send(JSON.stringify({ type: "response.cancel" }));
        socket.current.send(JSON.stringify({ type: "response.create", response: { instructions: `同一主题已追问三层。现在由【${ROLE_LABEL[lastRole.current]}】切换到一个新主题，只问一个问题。` } }));
      }
    }
    if (parsed.kind === "error") setError(parsed.message);
    if (parsed.kind === "speech-started") {
      stopAudio();
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "response.cancel" }));
    }
    if (parsed.kind === "ready") {
      sessionReady.current = true;
      beginSession();
    }
  }, [beginSession, persistTranscript, playAudio, stopAudio]);

  const connect = useCallback(async () => {
    if (!interviewId) return;
    manualClose.current = false;
    const generation = ++connectionGeneration.current;
    const isCurrent = () => generation === connectionGeneration.current && !manualClose.current;
    sessionReady.current = false;
    micPermissionSettled.current = false;
    sessionStarted.current = false;
    setError("");
    setState("connecting");
    const response = await fetch("/api/realtime/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interviewId }),
    });
    if (!isCurrent()) return;
    const session = await response.json();
    if (!isCurrent()) return;
    if (!response.ok) throw new Error(session.error ?? "无法创建实时会话");
    roleInstructions.current = { ...roleInstructions.current, ...(session.roleInstructions ?? {}) };
    const context = new AudioContext();
    audio.current = context;
    await context.resume();
    if (!isCurrent()) {
      await context.close().catch(() => undefined);
      return;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}${session.websocketPath}`);
    socket.current = ws;
    ws.onmessage = (event) => { if (isCurrent()) handleMessage(event); };
    ws.onerror = () => { if (isCurrent()) setError("实时连接异常，正在尝试恢复"); };
    ws.onclose = (event) => {
      if (socket.current !== ws) return;
      sessionReady.current = false;
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      sessionStarted.current = false;
      micPermissionSettled.current = false;
      if (manualClose.current) return;
      void saveEvent({ type: "connection", payload: { state: "disconnected", atMs: elapsedMs.current } });
      processor.current?.disconnect();
      connectionGeneration.current += 1;
      stream.current?.getTracks().forEach((track) => track.stop());
      void audio.current?.close();
      const decision = reconnectDecision(++reconnectAttempts.current);
      if (!decision.retry) {
        setState("text");
        setError(`实时语音连续断开，已自动切换到文字模式${event.reason ? `：${event.reason}` : ""}`);
        return;
      }
      setState("reconnecting");
      setTimeout(() => {
        if (manualClose.current || socket.current !== ws) return;
        void reconnect.current().catch(() => {
          setState("text");
          setError("自动重连失败，已切换到文字模式");
        });
      }, decision.delayMs);
    };
    micAvailable.current = true;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!isCurrent()) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const source = context.createMediaStreamSource(media);
      const node = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      processor.current = node;
      source.connect(node); node.connect(silent); silent.connect(context.destination);
      node.onaudioprocess = (audioEvent) => {
        if (!sessionReady.current || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: floatToPcm16(audioEvent.inputBuffer.getChannelData(0), context.sampleRate) }));
      };
    } catch {
      if (!isCurrent()) return;
      micAvailable.current = false;
    }
    if (!isCurrent()) return;
    micPermissionSettled.current = true;
    beginSession();
  }, [beginSession, handleMessage, interviewId, saveEvent]);
  reconnect.current = connect;

  const sendText = useCallback(async (text: string) => {
    if (!text.trim() || !interviewId || state !== "text") return;
    setState("text");
    const atMs = elapsedMs.current;
    setTranscripts((items) => [...items, { role: "candidate", text: text.trim(), atMs }]);
    const response = await fetch(`/api/interviews/${interviewId}/text`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim(), role: lastRole.current, atMs }),
    });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "文字回答发送失败"); return; }
    setTranscripts((items) => [...items, { role: lastRole.current, text: body.reply, atMs }]);
  }, [interviewId, state]);

  const disconnect = useCallback(async () => {
    manualClose.current = true;
    connectionGeneration.current += 1;
    sessionReady.current = false;
    micPermissionSettled.current = false;
    sessionStarted.current = false;
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    processor.current?.disconnect();
    stream.current?.getTracks().forEach((track) => track.stop());
    stopAudio();
    socket.current?.close();
    await audio.current?.close().catch(() => undefined);
    await flushEvents();
    setState("idle");
  }, [flushEvents, stopAudio]);

  useEffect(() => {
    setTranscripts([]);
    transcriptRef.current = [];
    eventQueue.current = [];
    topicQuestionDepth.current = 0;
    reconnectAttempts.current = 0;
    roleInstructions.current = {};
    connectionGeneration.current += 1;
    micPermissionSettled.current = false;
    sessionStarted.current = false;
    elapsedMs.current = 0;
    lastRole.current = "chair";
    stopAudio();
  }, [interviewId, stopAudio]);
  useEffect(() => () => { void disconnect(); }, [disconnect]);
  return { state, transcripts, error, connect, disconnect, sendText };
}