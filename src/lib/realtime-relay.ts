type UpstreamTranslation = { toBrowser: string[]; toUpstream: string[] };

export class RealtimeRelayTranslator {
  private readonly controlQueue: string[] = [];
  private awaitingControlUpdate = false;
  private responseActive = false;

  constructor(private readonly baseInstructions: string) {}
  private createSessionUpdate(instruction: string) {
    return JSON.stringify({
      type: "session.update",
      session: { instructions: `${this.baseInstructions}\n\n当前控制指令：${instruction}` },
    });
  }

  fromBrowser(payload: string): string[] {
    try {
      const event = JSON.parse(payload) as { type?: string; response?: { instructions?: unknown } };
      const instruction = event.response?.instructions;
      if (event.type === "response.create" && typeof instruction === "string" && instruction.trim()) {
        this.controlQueue.push(instruction.trim());
        if (this.awaitingControlUpdate || this.responseActive) return [];
        this.awaitingControlUpdate = true;
        return [this.createSessionUpdate(this.controlQueue[0])];
      }
    } catch {
      // Let the upstream service validate non-JSON or unknown protocol messages.
    }
    return [payload];
  }

  fromUpstream(payload: string): UpstreamTranslation {
    const result: UpstreamTranslation = { toBrowser: [payload], toUpstream: [] };
    try {
      const event = JSON.parse(payload) as { type?: string };
      if (event.type === "session.updated" && this.awaitingControlUpdate) {
        this.controlQueue.shift();
        this.awaitingControlUpdate = false;
        this.responseActive = true;
        result.toUpstream.push(JSON.stringify({ type: "response.create" }));
      }
      if (event.type === "response.done") {
        this.responseActive = false;
        const nextInstruction = this.controlQueue[0];
        if (nextInstruction && !this.awaitingControlUpdate) {
          this.awaitingControlUpdate = true;
          result.toUpstream.push(this.createSessionUpdate(nextInstruction));
        }
      }
    } catch {
      // Pass through non-JSON upstream messages unchanged.
    }
    return result;
  }
}
