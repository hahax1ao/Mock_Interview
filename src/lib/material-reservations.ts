import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { materialChunks, materialHashReservations, materials, profileFacts } from "@/db/schema";
import type { PersistCreatedInput } from "./material-ingestion";

export const MATERIAL_RESERVATION_LEASE_MS = 5 * 60_000;

type Owner = { materialId: string; name: string; createdAt: number };

export async function reserveMaterialHash(contentHash: string, owner: Owner, now = Date.now()) {
  const leaseUntil = now + MATERIAL_RESERVATION_LEASE_MS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimed = await db.run(sql`
      INSERT INTO material_hash_reservations
        (content_hash, material_id, name, created_at, state, lease_until)
      VALUES
        (${contentHash}, ${owner.materialId}, ${owner.name}, ${owner.createdAt}, 'pending', ${leaseUntil})
      ON CONFLICT(content_hash) DO UPDATE SET
        material_id = excluded.material_id,
        name = excluded.name,
        created_at = excluded.created_at,
        state = 'pending',
        lease_until = excluded.lease_until
      WHERE material_hash_reservations.state = 'pending'
        AND material_hash_reservations.lease_until <= ${now}
      RETURNING content_hash
    `);
    if (claimed.rows.length) return { kind: "reserved" as const };

    const [existing] = await db.select().from(materialHashReservations)
      .where(eq(materialHashReservations.contentHash, contentHash));
    if (!existing) continue;
    if (existing.state === "committed") {
      return {
        kind: "duplicate" as const,
        material: { id: existing.materialId, name: existing.name, createdAt: existing.createdAt },
      };
    }
    return {
      kind: "in_progress" as const,
      owner: { id: existing.materialId, name: existing.name, createdAt: existing.createdAt },
    };
  }
  throw new Error("Material reservation changed repeatedly during acquisition");
}

export async function persistReservedMaterial(input: PersistCreatedInput) {
  await db.transaction(async (tx) => {
    const ownership = await tx.update(materialHashReservations)
      .set({ state: "committed", leaseUntil: null })
      .where(and(
        eq(materialHashReservations.contentHash, input.material.contentHash),
        eq(materialHashReservations.materialId, input.material.id),
        eq(materialHashReservations.state, "pending"),
      ))
      .returning({ contentHash: materialHashReservations.contentHash });
    if (ownership.length !== 1) throw new Error("Material reservation ownership lost");

    await tx.insert(materials).values(input.material);
    if (input.chunks.length) await tx.insert(materialChunks).values(input.chunks);
    if (input.facts.length) await tx.insert(profileFacts).values(input.facts);
  });
}

export async function releaseMaterialHashReservation(contentHash: string, materialId: string) {
  await db.delete(materialHashReservations).where(and(
    eq(materialHashReservations.contentHash, contentHash),
    eq(materialHashReservations.materialId, materialId),
    eq(materialHashReservations.state, "pending"),
  ));
}

export async function reconcileMaterialHashReservations(now = Date.now()) {
  await db.transaction(async (tx) => {
    const existingMaterials = await tx.select({
      id: materials.id,
      name: materials.name,
      contentHash: materials.contentHash,
      createdAt: materials.createdAt,
    }).from(materials).orderBy(asc(materials.createdAt), asc(materials.id));
    const canonicalByHash = new Map<string, typeof existingMaterials[number]>();
    for (const material of existingMaterials) {
      if (material.contentHash && !canonicalByHash.has(material.contentHash)) {
        canonicalByHash.set(material.contentHash, material);
      }
    }

    for (const [contentHash, canonical] of canonicalByHash) {
      await tx.insert(materialHashReservations).values({
        contentHash,
        materialId: canonical.id,
        name: canonical.name,
        createdAt: canonical.createdAt,
        state: "committed",
        leaseUntil: null,
      }).onConflictDoUpdate({
        target: materialHashReservations.contentHash,
        set: {
          materialId: canonical.id,
          name: canonical.name,
          createdAt: canonical.createdAt,
          state: "committed",
          leaseUntil: null,
        },
      });
    }

    const reservations = await tx.select().from(materialHashReservations);
    for (const reservation of reservations) {
      if (canonicalByHash.has(reservation.contentHash)) continue;
      if (reservation.state === "pending" && (reservation.leaseUntil === null || reservation.leaseUntil > now)) continue;
      await tx.delete(materialHashReservations).where(and(
        eq(materialHashReservations.contentHash, reservation.contentHash),
        eq(materialHashReservations.materialId, reservation.materialId),
        eq(materialHashReservations.state, reservation.state),
      ));
    }
  });
}
