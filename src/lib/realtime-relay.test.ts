import { describe, expect, it } from "vitest";
import { RealtimeRelayTranslator } from "./realtime-relay";

describe("RealtimeRelayTranslator", () => {
  it("translates per-turn instructions into a session update followed by a valid response.create", () => {
    const translator = new RealtimeRelayTranslator("base interview instructions");

    const first = translator.fromBrowser(JSON.stringify({
      type: "response.create",
      response: { instructions: "open the interview" },
    }));

    expect(first).toEqual([JSON.stringify({
      type: "session.update",
      session: { instructions: "base interview instructions\n\n当前控制指令：open the interview" },
    })]);

    const second = translator.fromUpstream(JSON.stringify({ type: "session.updated" }));
    expect(second.toUpstream).toEqual([JSON.stringify({ type: "response.create" })]);
    expect(second.toBrowser).toEqual([JSON.stringify({ type: "session.updated" })]);
  });

  it("passes ordinary realtime messages through unchanged", () => {
    const translator = new RealtimeRelayTranslator("base");
    const audio = JSON.stringify({ type: "input_audio_buffer.append", audio: "AQI=" });
    const event = JSON.stringify({ type: "response.audio.delta", delta: "AQI=" });

    expect(translator.fromBrowser(audio)).toEqual([audio]);
    expect(translator.fromUpstream(event)).toEqual({ toBrowser: [event], toUpstream: [] });
  });

  it("serializes consecutive control instructions", () => {
    const translator = new RealtimeRelayTranslator("base");
    const control = (instructions: string) => JSON.stringify({
      type: "response.create",
      response: { instructions },
    });

    expect(translator.fromBrowser(control("first"))).toEqual([
      JSON.stringify({ type: "session.update", session: { instructions: "base\n\n当前控制指令：first" } }),
    ]);
    expect(translator.fromBrowser(control("second"))).toEqual([]);

    expect(translator.fromUpstream(JSON.stringify({ type: "session.updated" })).toUpstream).toEqual([
      JSON.stringify({ type: "response.create" }),
    ]);

    expect(translator.fromUpstream(JSON.stringify({ type: "response.done" })).toUpstream).toEqual([
      JSON.stringify({ type: "session.update", session: { instructions: "base\n\n当前控制指令：second" } }),
    ]);

    expect(translator.fromUpstream(JSON.stringify({ type: "session.updated" })).toUpstream).toEqual([
      JSON.stringify({ type: "response.create" }),
    ]);
  });
});
