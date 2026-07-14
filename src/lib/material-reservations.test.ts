import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, initDatabase } from "@/db/client";
import { materialHashReservations, materials } from "@/db/schema";
import {
  commitMaterialHashReservation,
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

  it("commits and releases only an owned pending reservation", async () => {
    const committedHash = hash();
    const releasedHash = hash();
    await reserveMaterialHash(committedHash, { materialId: "owner", name: "one", createdAt: 1 }, 1_000);
    await reserveMaterialHash(releasedHash, { materialId: "owner", name: "two", createdAt: 1 }, 1_000);
    await commitMaterialHashReservation(committedHash, "owner");
    await releaseMaterialHashReservation(committedHash, "owner");
    await releaseMaterialHashReservation(releasedHash, "owner");
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, committedHash)))
      .toEqual([expect.objectContaining({ state: "committed", leaseUntil: null })]);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, releasedHash)))
      .toEqual([]);
  });

  it("reconciles a deterministic legacy canonical and removes only stale pending reservations", async () => {
    const contentHash = hash();
    const staleHash = hash();
    const firstId = `a-${crypto.randomUUID()}`;
    const secondId = `b-${crypto.randomUUID()}`;
    materialIds.push(firstId, secondId);
    await db.insert(materials).values([
      { id: secondId, name: "second", category: "personal", mimeType: "text/plain", filePath: "second", contentHash, createdAt: 20 },
      { id: firstId, name: "first", category: "personal", mimeType: "text/plain", filePath: "first", contentHash, createdAt: 10 },
    ]);
    await db.insert(materialHashReservations).values({ contentHash: staleHash, materialId: "crashed", name: "crashed", createdAt: 1, state: "pending", leaseUntil: 9 });
    await reconcileMaterialHashReservations(10);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, contentHash)))
      .toEqual([expect.objectContaining({ materialId: firstId, state: "committed", leaseUntil: null })]);
    expect(await db.select().from(materialHashReservations).where(eq(materialHashReservations.contentHash, staleHash))).toEqual([]);
    expect(await db.select().from(materials).where(eq(materials.contentHash, contentHash))).toHaveLength(2);
  });
});
