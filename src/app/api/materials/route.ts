import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { materialChunks, materialHashReservations, materials, profileFacts } from "@/db/schema";
import { chunkMaterial } from "@/domain/materials";
import { resolveLocalStorageRoot } from "@/lib/local-storage";
import { ingestMaterial } from "@/lib/material-ingestion";
import { parseMaterial } from "@/lib/material-parser";
import { extractSmartFacts } from "@/lib/material-smart-extraction";
import { extractLocalFacts } from "@/lib/profile-extraction";

export const runtime = "nodejs";
const categorySchema = z.enum(["personal", "target", "reference"]);

export async function GET() {
  await initDatabase();
  const items = await db.select().from(materials).orderBy(desc(materials.createdAt));
  const facts = await db.select().from(profileFacts);
  return NextResponse.json({ materials: items, facts });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const category = categorySchema.parse(form.get("category") ?? "personal");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择文件" }, { status: 400 });
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "单个文件不能超过 20MB" }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const uploadsRoot = resolve(resolveLocalStorageRoot(), "uploads");
    await initDatabase();
    const result = await ingestMaterial({
      name: file.name,
      mimeType: file.type,
      category,
      buffer,
    }, {
      listMaterials: () => db.select({
        id: materials.id,
        name: materials.name,
        filePath: materials.filePath,
        contentHash: materials.contentHash,
        createdAt: materials.createdAt,
      }).from(materials),
      updateMaterialHash: async (id, contentHash) => {
        await db.update(materials).set({ contentHash }).where(eq(materials.id, id));
      },
      reserveContentHash: async (contentHash, owner) => {
        const inserted = await db.insert(materialHashReservations).values({
          contentHash,
          materialId: owner.materialId,
          name: owner.name,
          createdAt: owner.createdAt,
        }).onConflictDoNothing().returning({ contentHash: materialHashReservations.contentHash });
        if (inserted.length) return { kind: "reserved" as const };
        const [duplicate] = await db.select().from(materialHashReservations)
          .where(eq(materialHashReservations.contentHash, contentHash));
        if (!duplicate) throw new Error("材料哈希预留状态不一致");
        return {
          kind: "duplicate" as const,
          material: { id: duplicate.materialId, name: duplicate.name, createdAt: duplicate.createdAt },
        };
      },
      releaseContentHash: async (contentHash, materialId) => {
        await db.delete(materialHashReservations).where(and(
          eq(materialHashReservations.contentHash, contentHash),
          eq(materialHashReservations.materialId, materialId),
        ));
      },
      writeUpload: async ({ materialId, name, buffer: contents }) => {
        const safeName = name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
        const directory = resolve(uploadsRoot, materialId);
        const filePath = resolve(directory, safeName);
        await mkdir(directory, { recursive: true });
        await writeFile(filePath, contents);
        return filePath;
      },
      removeUpload: async (materialId) => {
        await rm(resolve(uploadsRoot, materialId), { recursive: true, force: true });
      },
      parseMaterial,
      chunkMaterial,
      extractLocalFacts,
      extractSmartFacts,
      persistCreated: async ({ material, chunks, facts }) => {
        await db.transaction(async (tx) => {
          await tx.insert(materials).values(material);
          if (chunks.length) await tx.insert(materialChunks).values(chunks);
          if (facts.length) await tx.insert(profileFacts).values(facts);
        });
      },
      createId: randomUUID,
      now: Date.now,
    });

    if (result.kind === "duplicate") {
      return NextResponse.json({
        error: "该材料已上传",
        duplicateMaterial: result.material,
      }, { status: 409 });
    }

    return NextResponse.json({
      material: { id: result.materialId, name: file.name, category },
      pages: result.pages,
      chunks: result.chunks,
      parseStatus: result.parseStatus,
      localFacts: result.localFacts,
      smartFacts: result.smartFacts,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "材料解析失败",
    }, { status: 400 });
  }
}
