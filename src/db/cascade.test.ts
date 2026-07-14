import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteMaterial } from "@/app/api/materials/[id]/route";
import { resolveLocalStorageRoot } from "@/lib/local-storage";
import { db, initDatabase } from "./client";
import { interviewEvents, interviews, materialChunks, materialHashReservations, materials, profileFacts, reviewReports } from "./schema";

describe("interview cascade deletion", () => {
  it("removes transcripts and derived review reports", async () => {
    await initDatabase();
    const id = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    await db.insert(interviews).values({
      id, status: "finished", duration: 10, focus: "cascade-test", pressure: "adaptive",
      materialIds: [], plan: [], createdAt: Date.now(),
    });
    await db.insert(interviewEvents).values({
      id: eventId, interviewId: id, type: "transcript", payload: { text: "test" }, createdAt: Date.now(),
    });
    await db.insert(reviewReports).values({
      id: reportId, interviewId: id, status: "complete", report: {}, createdAt: Date.now(), updatedAt: Date.now(),
    });

    await db.delete(interviews).where(eq(interviews.id, id));

    expect(await db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, id))).toHaveLength(0);
    expect(await db.select().from(reviewReports).where(eq(reviewReports.interviewId, id))).toHaveLength(0);
  });

  it("deduplicates a retried event with the same client id", async () => {
    await initDatabase();
    const interviewId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await db.insert(interviews).values({
      id: interviewId, status: "active", duration: 10, focus: "retry-test", pressure: "adaptive",
      materialIds: [], plan: [], createdAt: Date.now(),
    });
    const event = { id: eventId, interviewId, type: "transcript", payload: { text: "once" }, createdAt: Date.now() };
    await db.insert(interviewEvents).values(event).onConflictDoNothing();
    await db.insert(interviewEvents).values(event).onConflictDoNothing();
    expect(await db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, interviewId))).toHaveLength(1);
    await db.delete(interviews).where(eq(interviews.id, interviewId));
  });

  it("removes material chunks and facts while preserving interview history snapshots", async () => {
    await initDatabase();
    const materialId = crypto.randomUUID();
    const interviewId = crypto.randomUUID();
    await db.insert(materials).values({
      id: materialId, name: "resume.pdf", category: "personal", mimeType: "application/pdf",
      filePath: `uploads/${materialId}/resume.pdf`, status: "ready", createdAt: Date.now(),
    });
    await db.insert(materialChunks).values({
      id: crypto.randomUUID(), materialId, source: "resume.pdf", page: 1,
      text: "education", start: 0, end: 9,
    });
    await db.insert(profileFacts).values({
      id: crypto.randomUUID(), materialId, field: "major", value: "CS", source: "resume.pdf",
      confidence: 1, confirmed: true,
    });
    await db.insert(interviews).values({
      id: interviewId, status: "finished", duration: 10, focus: "history", pressure: "adaptive",
      materialIds: [materialId], plan: [], createdAt: Date.now(),
    });

    await db.transaction(async (tx) => {
      await tx.delete(materials).where(eq(materials.id, materialId));
    });

    expect(await db.select().from(materialChunks).where(eq(materialChunks.materialId, materialId))).toHaveLength(0);
    expect(await db.select().from(profileFacts).where(eq(profileFacts.materialId, materialId))).toHaveLength(0);
    const [history] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(history.materialIds).toEqual([materialId]);
    await db.delete(interviews).where(eq(interviews.id, interviewId));
  });
});


describe("DELETE /api/materials/:id", () => {
  it("returns 404 when the material does not exist", async () => {
    const response = await deleteMaterial(
      new Request("http://localhost/api/materials/missing", { method: "DELETE" }),
      { params: Promise.resolve({ id: crypto.randomUUID() }) },
    );

    expect(response.status).toBe(404);
  });

  it("deletes the material through the database cascade and removes its upload", async () => {
    await initDatabase();
    const materialId = crypto.randomUUID();
    const storageRoot = resolveLocalStorageRoot();
    const uploadDirectory = join(storageRoot, "uploads", materialId);
    const filePath = join(uploadDirectory, "resume.pdf");
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(filePath, "resume");
    await db.insert(materials).values({
      id: materialId, name: "resume.pdf", category: "personal", mimeType: "application/pdf",
      filePath, status: "ready", createdAt: Date.now(),
    });
    await db.insert(materialChunks).values({
      id: crypto.randomUUID(), materialId, source: "resume.pdf", page: 1,
      text: "education", start: 0, end: 9,
    });

    try {
      const response = await deleteMaterial(
        new Request(`http://localhost/api/materials/${materialId}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: materialId }) },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deletedId: materialId, cleanupPending: false });
      expect(await db.select().from(materials).where(eq(materials.id, materialId))).toHaveLength(0);
      expect(await db.select().from(materialChunks).where(eq(materialChunks.materialId, materialId))).toHaveLength(0);
      await expect(readdir(uploadDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await db.delete(materials).where(eq(materials.id, materialId));
      await rm(uploadDirectory, { recursive: true, force: true });
    }
  });

  it("reassigns a deleted hash reservation to the deterministic remaining legacy material", async () => {
    await initDatabase();
    const storageRoot = resolveLocalStorageRoot();
    const hash = crypto.randomUUID();
    const firstId = `a-${crypto.randomUUID()}`;
    const secondId = `b-${crypto.randomUUID()}`;
    const firstDirectory = join(storageRoot, "uploads", firstId);
    const secondDirectory = join(storageRoot, "uploads", secondId);
    const firstPath = join(firstDirectory, "first.pdf");
    const secondPath = join(secondDirectory, "second.pdf");
    await mkdir(firstDirectory, { recursive: true });
    await mkdir(secondDirectory, { recursive: true });
    await writeFile(firstPath, "same");
    await writeFile(secondPath, "same");
    await db.insert(materials).values([
      { id: firstId, name: "first.pdf", category: "personal", mimeType: "application/pdf", filePath: firstPath, status: "ready", contentHash: hash, createdAt: 100 },
      { id: secondId, name: "second.pdf", category: "personal", mimeType: "application/pdf", filePath: secondPath, status: "ready", contentHash: hash, createdAt: 200 },
    ]);
    await db.insert(materialHashReservations).values({
      contentHash: hash, materialId: firstId, name: "first.pdf", createdAt: 100,
    });

    try {
      const response = await deleteMaterial(
        new Request(`http://localhost/api/materials/${firstId}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: firstId }) },
      );

      expect(response.status).toBe(200);
      expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, hash)))
        .toEqual([expect.objectContaining({ materialId: secondId, name: "second.pdf" })]);
      expect(await db.select().from(materials).where(eq(materials.id, secondId))).toHaveLength(1);
    } finally {
      await db.delete(materialHashReservations).where(eq(materialHashReservations.contentHash, hash));
      await db.delete(materials).where(eq(materials.id, firstId));
      await db.delete(materials).where(eq(materials.id, secondId));
      await rm(firstDirectory, { recursive: true, force: true });
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });});
