export type ParsedRealtimeEvent =
  | { kind: "audio"; data: string }
  | { kind: "transcript"; speaker: "candidate" | "teacher"; text: string }
  | { kind: "ready" }
  | { kind: "speech-started" }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

export function parseRealtimeServerEvent(message: unknown): ParsedRealtimeEvent {
  if (!message || typeof message !== "object") return { kind: "ignore" };
  const event = message as Record<string, unknown>;
  if (event.type === "response.audio.delta" && typeof event.delta === "string") {
    return { kind: "audio", data: event.delta };
  }
  if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string" && event.transcript.trim()) {
    return { kind: "transcript", speaker: "candidate", text: event.transcript.trim() };
  }
  if (event.type === "response.audio_transcript.done" && typeof event.transcript === "string" && event.transcript.trim()) {
    return { kind: "transcript", speaker: "teacher", text: event.transcript.trim() };
  }
  if (event.type === "session.updated") return { kind: "ready" };
  if (event.type === "input_audio_buffer.speech_started") return { kind: "speech-started" };
  if (event.type === "error") {
    const detail = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : {};
    return { kind: "error", message: typeof detail.message === "string" ? detail.message : "百炼实时会话返回错误" };
  }
  return { kind: "ignore" };
}