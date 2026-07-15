import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, initDatabase } from "@/db/client";
import { materialChunks, materials, profileExperiences } from "@/db/schema";

const { extractSmartMaterialProfile } = vi.hoisted(() => ({
  extractSmartMaterialProfile: vi.fn(),
}));

vi.mock("@/lib/material-smart-extraction", () => ({ extractSmartMaterialProfile }));

import { POST } from "./route";

const materialIds: string[] = [];

afterEach(async () => {
  extractSmartMaterialProfile.mockReset();
  await Promise.all(materialIds.splice(0).map((id) => db.delete(materials).where(eq(materials.id, id))));
});

describe("POST material smart-extraction retry", () => {
  it("does not overwrite a draft confirmed while extraction is in flight", async () => {
    await initDatabase();
    const materialId = `retry-${crypto.randomUUID()}`;
    const experienceId = `experience-${crypto.randomUUID()}`;
    materialIds.push(materialId);
    await db.insert(materials).values({
      id: materialId,
      name: "resume.txt",
      category: "personal",
      mimeType: "text/plain",
      filePath: "resume.txt",
      status: "ready",
      contentHash: crypto.randomUUID(),
      parseStatus: "basic_only",
      createdAt: 1,
    });
    await db.insert(materialChunks).values({
      id: `chunk-${crypto.randomUUID()}`,
      materialId,
      source: "resume.txt",
      page: 1,
      text: "Atlas model evidence",
      start: 0,
      end: 20,
    });
    await db.insert(profileExperiences).values({
      id: experienceId,
      materialId,
      type: "project",
      title: "Atlas",
      background: "original",
      responsibilities: "original",
      methods: "draft before retry",
      results: "original",
      awardRole: "",
      source: "resume.txt",
      page: 1,
      evidence: { title: "Atlas", methods: "draft before retry" },
      confidence: 0.7,
      status: "draft",
      createdAt: 10,
      updatedAt: 10,
    });

    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    let finishExtraction!: () => void;
    const finish = new Promise<void>((resolve) => { finishExtraction = resolve; });
    extractSmartMaterialProfile.mockImplementation(async () => {
      extractionStarted();
      await finish;
      return {
        facts: [],
        experiences: [{
          type: "project" as const,
          title: "Atlas",
          background: "model background",
          responsibilities: "model responsibilities",
          methods: "model overwrite",
          results: "model result",
          awardRole: "",
          source: "resume.txt",
          page: 1,
          evidence: { title: "Atlas", methods: "model evidence" },
          confidence: 0.8,
        }],
      };
    });

    const retry = POST(new Request("http://localhost/api/materials/retry"), {
      params: Promise.resolve({ id: materialId }),
    });
    await started;
    await db.update(profileExperiences).set({
      status: "confirmed",
      methods: "confirmed user edit",
      updatedAt: 20,
    }).where(eq(profileExperiences.id, experienceId));
    finishExtraction();

    const response = await retry;
    expect(response.status).toBe(200);
    const [persisted] = await db.select().from(profileExperiences)
      .where(eq(profileExperiences.id, experienceId));
    expect(persisted).toEqual(expect.objectContaining({
      status: "confirmed",
      methods: "confirmed user edit",
      createdAt: 10,
      updatedAt: 20,
    }));

    const laterRetry = await POST(new Request("http://localhost/api/materials/retry"), {
      params: Promise.resolve({ id: materialId }),
    });
    expect(laterRetry.status).toBe(200);
    const afterLaterRetry = await db.select().from(profileExperiences)
      .where(eq(profileExperiences.materialId, materialId));
    expect(afterLaterRetry).toHaveLength(1);
    expect(afterLaterRetry[0]).toEqual(expect.objectContaining({
      status: "confirmed",
      methods: "confirmed user edit",
    }));
  });
  it("updates the canonical normalized draft and never a migrated legacy suffix", async () => {
    await initDatabase();
    const materialId = `retry-${crypto.randomUUID()}`;
    materialIds.push(materialId);
    await db.insert(materials).values({
      id: materialId, name: "resume.txt", category: "personal", mimeType: "text/plain",
      filePath: "resume.txt", status: "ready", contentHash: crypto.randomUUID(), parseStatus: "basic_only", createdAt: 1,
    });
    await db.insert(materialChunks).values({
      id: `chunk-${crypto.randomUUID()}`, materialId, source: "resume.txt", page: 1,
      text: "Atlas model evidence", start: 0, end: 20,
    });
    const base = {
      materialId, type: "project" as const, background: "original", responsibilities: "original",
      methods: "old method", results: "original", awardRole: "", source: "resume.txt", page: 1,
      evidence: { title: "Atlas", methods: "old method" }, confidence: 0.7, status: "draft" as const,
      createdAt: 10, updatedAt: 10,
    };
    await db.insert(profileExperiences).values([
      { ...base, id: `legacy-${crypto.randomUUID()}`, title: " Atlas ", normalizedKey: "atlas#legacy:old" },
      { ...base, id: `canonical-${crypto.randomUUID()}`, title: "Ａｔｌａｓ", normalizedKey: "atlas", updatedAt: 20 },
    ]);
    extractSmartMaterialProfile.mockResolvedValue({ facts: [], experiences: [{
      type: "project", title: "Atlas", background: "model background", responsibilities: "model responsibilities",
      methods: "refreshed method", results: "model result", awardRole: "", source: "resume.txt", page: 1,
      evidence: { title: "Atlas", methods: "model evidence" }, confidence: 0.8,
    }] });

    const response = await POST(new Request("http://localhost/api/materials/retry"), {
      params: Promise.resolve({ id: materialId }),
    });

    expect(response.status).toBe(200);
    const persisted = await db.select().from(profileExperiences).where(eq(profileExperiences.materialId, materialId));
    expect(persisted.find((item) => item.normalizedKey === "atlas")).toEqual(expect.objectContaining({ methods: "refreshed method" }));
    expect(persisted.find((item) => item.normalizedKey?.startsWith("atlas#legacy:"))).toEqual(expect.objectContaining({ methods: "old method" }));
  });
  it("deduplicates the same draft across concurrent retries", async () => {
    await initDatabase();
    const materialId = `retry-${crypto.randomUUID()}`;
    materialIds.push(materialId);
    await db.insert(materials).values({
      id: materialId,
      name: "resume.txt",
      category: "personal",
      mimeType: "text/plain",
      filePath: "resume.txt",
      status: "ready",
      contentHash: crypto.randomUUID(),
      parseStatus: "basic_only",
      createdAt: 1,
    });
    await db.insert(materialChunks).values({
      id: `chunk-${crypto.randomUUID()}`,
      materialId,
      source: "resume.txt",
      page: 1,
      text: "Atlas model evidence",
      start: 0,
      end: 20,
    });

    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => { bothStarted = resolve; });
    extractSmartMaterialProfile.mockImplementation(async () => {
      started += 1;
      if (started === 2) bothStarted();
      await gate;
      return {
        facts: [],
        experiences: [{
          type: "project" as const,
          title: " Atlas ",
          background: "model background",
          responsibilities: "model responsibilities",
          methods: "model method",
          results: "model result",
          awardRole: "",
          source: "resume.txt",
          page: 1,
          evidence: { title: "Atlas", methods: "model evidence" },
          confidence: 0.8,
        }],
      };
    });

    const first = POST(new Request("http://localhost/api/materials/retry"), {
      params: Promise.resolve({ id: materialId }),
    });
    const second = POST(new Request("http://localhost/api/materials/retry"), {
      params: Promise.resolve({ id: materialId }),
    });
    await ready;
    release();

    const responses = await Promise.all([first, second]);
    const responseBodies = await Promise.all(responses.map((response) => response.clone().json()));
    expect(responses.map((response) => response.status), JSON.stringify(responseBodies)).toEqual([200, 200]);
    const persisted = await db.select().from(profileExperiences)
      .where(eq(profileExperiences.materialId, materialId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(expect.objectContaining({ title: " Atlas ", status: "draft" }));
  });
});