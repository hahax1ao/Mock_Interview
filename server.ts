import { createServer } from "node:http";
import next from "next";
import { WebSocket, WebSocketServer } from "ws";
import { consumeRealtimeToken } from "./src/lib/realtime-tokens";
import { interviewerPrompt } from "./src/lib/interviewer-prompt";
import { buildInterviewContext } from "./src/lib/interview-context";
import { models } from "./src/lib/models";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();
const relay = new WebSocketServer({ noServer: true });
type InterviewSocket = WebSocket & { interviewId?: string };

function realtimeEndpoint() {
  if (process.env.DASHSCOPE_REALTIME_URL) return process.env.DASHSCOPE_REALTIME_URL;
  const workspace = process.env.QWEN_WORKSPACE_ID ?? process.env.DASHSCOPE_WORKSPACE_ID;
  const region = process.env.QWEN_REGION ?? "cn-beijing";
  if (workspace) return `wss://${workspace}.${region}.maas.aliyuncs.com/api-ws/v1/realtime`;
  if (region !== "cn-beijing") throw new Error("非北京地域必须配置 QWEN_WORKSPACE_ID");
  // The legacy Beijing endpoint remains supported and was verified with a live handshake.
  return "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
}

async function start() {
  await app.prepare();
  const upgradeHandler = app.getUpgradeHandler();

  relay.on("connection", async (browser: InterviewSocket) => {
    const apiKey = process.env.ALIYUN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey || apiKey.includes("your-key") || !browser.interviewId) {
      browser.close(1011, "Alibaba Cloud configuration is incomplete");
      return;
    }

    try {
      const context = await buildInterviewContext(browser.interviewId);
      const target = new URL(realtimeEndpoint());
      target.searchParams.set("model", models.realtime);
      const upstream = new WebSocket(target, { headers: { Authorization: `Bearer ${apiKey}` } });
      const pending: Array<Buffer | string> = [];

      upstream.on("open", () => {
        upstream.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: interviewerPrompt + context,
            voice: process.env.QWEN_VOICE ?? "Tina",
            input_audio_format: "pcm",
            output_audio_format: "pcm",
            input_audio_transcription: { model: process.env.QWEN_ASR_MODEL ?? "qwen3-asr-flash-realtime" },
            turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 650 },
          },
        }));
        for (const message of pending) upstream.send(message);
        pending.length = 0;
      });

      browser.on("message", (data) => {
        const payload = Buffer.isBuffer(data) ? data : data.toString();
        if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push(payload);
      });
      upstream.on("message", (data) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
      });
      upstream.on("close", (code, reason) => browser.close(code || 1011, reason.toString()));
      upstream.on("error", () => browser.close(1011, "Bailian realtime connection failed"));
      browser.on("close", () => upstream.close());
    } catch (error) {
      browser.close(1011, error instanceof Error ? error.message : "Realtime initialization failed");
    }
  });

  const server = createServer((request, response) => handler(request, response));
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/realtime") return upgradeHandler(request, socket, head);
    const token = url.searchParams.get("token");
    const credential = token ? consumeRealtimeToken(token) : null;
    if (!credential) return socket.destroy();
    relay.handleUpgrade(request, socket, head, (websocket) => {
      (websocket as InterviewSocket).interviewId = credential.interviewId;
      relay.emit("connection", websocket, request);
    });
  });
  server.listen(port, hostname, () => console.log(`Baoyan Interview Agent ready at http://${hostname}:${port}`));
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});