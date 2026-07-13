import { describe, expect, it } from "vitest";
import { parseRealtimeServerEvent } from "./realtime-events";

describe("parseRealtimeServerEvent", () => {
  it("decodes only exact audio delta events", () => {
    expect(parseRealtimeServerEvent({ type: "response.audio.delta", delta: "AQI=" })).toEqual({ kind: "audio", data: "AQI=" });
    expect(parseRealtimeServerEvent({ type: "response.audio_transcript.delta", delta: "老师文本" })).toEqual({ kind: "ignore" });
  });

  it("returns only completed candidate and teacher transcripts", () => {
    expect(parseRealtimeServerEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "候选人回答" })).toEqual({ kind: "transcript", speaker: "candidate", text: "候选人回答" });
    expect(parseRealtimeServerEvent({ type: "response.audio_transcript.done", transcript: "老师问题" })).toEqual({ kind: "transcript", speaker: "teacher", text: "老师问题" });
  });

  it("surfaces protocol errors", () => {
    expect(parseRealtimeServerEvent({ type: "error", error: { message: "bad session" } })).toEqual({ kind: "error", message: "bad session" });
  });
});