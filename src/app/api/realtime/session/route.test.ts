import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews, materials, profileExperiences } from "@/db/schema";
import { POST } from "./route";

const createdInterviewIds: string[] = [];
const createdMaterialIds: string[] = [];
let originalApiKey: string | undefined;

beforeEach(async () => {
  originalApiKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "test-only-session-route-key";
  await initDatabase();
});

afterEach(async () => {
  for (const interviewId of createdInterviewIds.splice(0)) {
    await db.delete(interviews).where(eq(interviews.id, interviewId));
  }
  for (const materialId of createdMaterialIds.splice(0)) {
    await db.delete(materials).where(eq(materials.id, materialId));
  }
  if (originalApiKey === undefined) delete process.env.DASHSCOPE_API_KEY;
  else process.env.DASHSCOPE_API_KEY = originalApiKey;
});

async function createInterviewFixture(withConfirmedExperience: boolean) {
  const materialId = crypto.randomUUID();
  const interviewId = crypto.randomUUID();
  createdMaterialIds.push(materialId);
  createdInterviewIds.push(interviewId);
  await db.insert(materials).values({
    id: materialId, name: "resume.pdf", category: "personal", mimeType: "application/pdf",
    filePath: "test-only-resume.pdf", createdAt: 1,
  });
  await db.insert(interviews).values({
    id: interviewId, status: "ready", duration: 1200, focus: "LoRa 通信",
    pressure: "adaptive", materialIds: [materialId], plan: {}, createdAt: 1,
  });
  if (withConfirmedExperience) {
    await db.insert(profileExperiences).values({
      id: crypto.randomUUID(), materialId, type: "research", title: "Super-LoRa",
      background: "提升 LoRa 吞吐量", responsibilities: "负责 SDR 与算法验证",
      methods: "并行干扰消除", results: "吞吐量提升 1.35 倍", awardRole: "负责人",
      source: "resume.pdf", page: 2, evidence: { title: "Super-LoRa" }, confidence: 0.93,
      status: "confirmed", createdAt: 1, updatedAt: 1,
    });
  }
  return interviewId;
}

function request(interviewId: string) {
  return new Request("http://localhost/api/realtime/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ interviewId }),
  });
}

describe("POST realtime session route", () => {
  it("returns a research instruction naming the confirmed Super-LoRa card for the requested interview", async () => {
    const interviewId = await createInterviewFixture(true);

    const response = await POST(request(interviewId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.websocketPath).toContain("/realtime?token=");
    expect(body.roleInstructions.research).toContain("Super-LoRa");
    expect(body.roleInstructions.research).toContain("第一问必须点名这项经历");
  });

  it("returns no research override when the selected material has no confirmed card", async () => {
    const interviewId = await createInterviewFixture(false);

    const response = await POST(request(interviewId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.roleInstructions).toEqual({});
  });
});