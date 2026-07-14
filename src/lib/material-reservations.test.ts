import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, initDatabase } from "@/db/client";
import { materialChunks, materialHashReservations, materials, profileFacts } from "@/db/schema";
import {
  persistReservedMaterial,
  reconcileMaterialHashReservations,
  releaseMaterialHashReservation,
  reserveMaterialHash,
} from "./material-reservations";

const hashes: string[] = [];
const materialIds: string[] = [];

beforeEach(() => initDatabase());
afterEach(async () => {
  await Promise.all(hashes.splice(0).map((hash) => db.delete(materialHashReservations)
    .where(eq(materialHashReservations.contentHash, hash))));
  await Promise.all(materialIds.splice(0).map((id) => db.delete(materials).where(eq(materials.id, id))));
});

function hash() {
  const value = crypto.randomUUID();
  hashes.push(value);
  return value;
}

describe("material hash reservations", () => {
  it("atomically takes over an expired pending reservation", async () => {
    const contentHash = hash();
    await db.insert(materialHashReservations).values({
      contentHash, materialId: "old", name: "old.pdf", createdAt: 10,
      state: "pending", leaseUntil: 999,
    });

    await expect(reserveMaterialHash(contentHash, {
      materialId: "new", name: "new.pdf", createdAt: 20,
    }, 1_000)).resolves.toEqual({ kind: "reserved" });
    expect(await db.select().from(materialHashReservations)
      .where(eq(materialHashReservations.contentHash, contentHash)))
      .toEqual([expect.objectContaining({ materialId: "new", state: "pending" })]);
  });

  it("returns owner metadata for a nonexpired pending reservation", async () => {
    const contentHash = hash();
    await db.insert(materialHashReservations).values({
      contentHash, materialId: "owner", name: "owner.pdf", createdAt: 10,
      state: "pending", leaseUntil: 2_000,
    });

    await expect(reserveMaterialHash(contentHash, {
      materialId: "loser", name: "loser.pdf", createdAt: 20,
    }, 1_000)).resolves.toEqual({
      kind: "in_progress",
      owner: { id: "owner", name: "owner.pdf", createdAt: 10 },
    });
  });

  it("returns the canonical material for a committed reservation", async () => {
    const contentHash = hash();
    await db.insert(materialHashReservations).values({
      contentHash, materialId: "done", name: "done.pdf", createdAt: 10,
      state: "committed", leaseUntil: null,
    });

    await expect(reserveMaterialHash(contentHash, {
      materialId: "loser", name: "loser.pdf", createdAt: 20,
    }, 1_000)).resolves.toEqual({
      kind: "duplicate",
      material: { id: "done", name: "done.pdf", createdAt: 10 },
    });
  });

  it("releases only an owned pending reservation", async () => {
    const contentHash = hash();
    await reserveMaterialHash(contentHash, { materialId: "owner", name: "one", createdAt: 1 }, 1_000);
    await releaseMaterialHashReservation(contentHash, "other");
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, contentHash)))
      .toEqual([expect.objectContaining({ materialId: "owner", state: "pending" })]);
    await releaseMaterialHashReservation(contentHash, "owner");
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, contentHash)))
      .toEqual([]);
  });

  it("reconciles every reservation state while preserving legacy materials and active work", async () => {
    const contentHash = hash();
    const staleHash = hash();
    const orphanHash = hash();
    const activeHash = hash();
    const firstId = `a-${crypto.randomUUID()}`;
    const secondId = `b-${crypto.randomUUID()}`;
    materialIds.push(firstId, secondId);
    await db.insert(materials).values([
      { id: secondId, name: "second", category: "personal", mimeType: "text/plain", filePath: "second", contentHash, createdAt: 20 },
      { id: firstId, name: "first", category: "personal", mimeType: "text/plain", filePath: "first", contentHash, createdAt: 10 },
    ]);
    await db.insert(materialHashReservations).values([
      { contentHash, materialId: "wrong", name: "wrong", createdAt: 1, state: "pending", leaseUntil: 100 },
      { contentHash: staleHash, materialId: "crashed", name: "crashed", createdAt: 1, state: "pending", leaseUntil: 9 },
      { contentHash: orphanHash, materialId: "missing", name: "missing", createdAt: 1, state: "committed", leaseUntil: null },
      { contentHash: activeHash, materialId: "working", name: "working", createdAt: 1, state: "pending", leaseUntil: 11 },
    ]);
    await reconcileMaterialHashReservations(10);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, contentHash)))
      .toEqual([expect.objectContaining({ materialId: firstId, state: "committed", leaseUntil: null })]);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, staleHash))).toEqual([]);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, orphanHash))).toEqual([]);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, activeHash)))
      .toEqual([expect.objectContaining({ materialId: "working", state: "pending" })]);
    expect(await db.select().from(materials).where(eq(materials.contentHash, contentHash))).toHaveLength(2);
  });
  it("fences expired owners and persists only the takeover owner in one transaction", async () => {
    const contentHash = hash();
    const oldId = `old-${crypto.randomUUID()}`;
    const newId = `new-${crypto.randomUUID()}`;
    materialIds.push(oldId, newId);
    await reserveMaterialHash(contentHash, { materialId: oldId, name: "old", createdAt: 1 }, 1_000);
    await reserveMaterialHash(contentHash, { materialId: newId, name: "new", createdAt: 2 }, 1_000 + 5 * 60_000);

    await expect(persistReservedMaterial({
      material: { id: oldId, name: "old", category: "personal", mimeType: "text/plain", filePath: "old", status: "ready", contentHash, parseStatus: "complete", createdAt: 1 },
      chunks: [],
      facts: [{ id: `fact-${oldId}`, materialId: oldId, field: "model", value: "old", source: "old", confidence: 1, evidence: "old", page: 1, extractor: "qwen", confirmed: false }],
    })).rejects.toThrow("reservation ownership lost");
    await persistReservedMaterial({
      material: { id: newId, name: "new", category: "personal", mimeType: "text/plain", filePath: "new", status: "ready", contentHash, parseStatus: "complete", createdAt: 2 },
      chunks: [],
      facts: [{ id: `fact-${newId}`, materialId: newId, field: "model", value: "new", source: "new", confidence: 1, evidence: "new", page: 1, extractor: "qwen", confirmed: false }],
    });

    expect(await db.select().from(materials).where(eq(materials.contentHash, contentHash)))
      .toEqual([expect.objectContaining({ id: newId })]);
    expect(await db.select().from(profileFacts).where(eq(profileFacts.materialId, newId)))
      .toEqual([expect.objectContaining({ value: "new" })]);
  });

  it("rolls back material data and reservation commit when persistence fails", async () => {
    const contentHash = hash();
    const materialId = `rollback-${crypto.randomUUID()}`;
    materialIds.push(materialId);
    await reserveMaterialHash(contentHash, { materialId, name: "rollback", createdAt: 1 }, 1_000);
    const duplicateChunk = { id: `chunk-${crypto.randomUUID()}`, materialId, source: "x", page: 1, text: "x", start: 0, end: 1 };

    await expect(persistReservedMaterial({
      material: { id: materialId, name: "rollback", category: "personal", mimeType: "text/plain", filePath: "rollback", status: "ready", contentHash, parseStatus: "complete", createdAt: 1 },
      chunks: [duplicateChunk, duplicateChunk],
      facts: [],
    })).rejects.toThrow();

    expect(await db.select().from(materials).where(eq(materials.id, materialId))).toEqual([]);
    expect(await db.select().from(materialChunks).where(eq(materialChunks.materialId, materialId))).toEqual([]);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, contentHash)))
      .toEqual([expect.objectContaining({ materialId, state: "pending" })]);
  });
});
