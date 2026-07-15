import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { materials, profileExperiences, profileFacts } from "@/db/schema";
import { chunkMaterial } from "@/domain/materials";
import { resolveLocalStorageRoot } from "@/lib/local-storage";
import { ingestMaterial, type IngestionResult } from "@/lib/material-ingestion";
import { parseMaterial } from "@/lib/material-parser";
import { extractSmartMaterialProfile } from "@/lib/material-smart-extraction";
import { extractLocalFacts } from "@/lib/profile-extraction";
import {
  persistReservedMaterial,
  releaseMaterialHashReservation,
  reserveMaterialHash,
} from "@/lib/material-reservations";

export const runtime = "nodejs";
const categorySchema = z.enum(["personal", "target", "reference"]);
type MaterialConflict =
  | { kind: "duplicate"; material: { id: string; name: string; createdAt: number } }
  | { kind: "in_progress"; owner: { id: string; name: string; createdAt: number } }
  | { kind: "created" };

export function materialCreatedResponse(
  result: Extract<IngestionResult, { kind: "created" }>,
  file: { name: string; category: "personal" | "target" | "reference" },
) {
  return NextResponse.json({
    material: { id: result.materialId, name: file.name, category: file.category },
    pages: result.pages,
    chunks: result.chunks,
    parseStatus: result.parseStatus,
    localFacts: result.localFacts,
    smartFacts: result.smartFacts,
    experiences: result.experiences,
  }, { status: 201 });
}
export function materialConflictResponse(result: MaterialConflict) {
  if (result.kind === "duplicate") {
    return NextResponse.json({
      error: "该材料已上传",
      duplicateMaterial: result.material,
    }, { status: 409 });
  }
  if (result.kind === "in_progress") {
    return NextResponse.json({
      error: "相同材料正在处理中",
      inProgressOwner: result.owner,
    }, { status: 409 });
  }
  return null;
}

export interface GetMaterialsRouteDependencies {
  initDatabase(): Promise<void>;
  listMaterials(): Promise<unknown[]>;
  listFacts(): Promise<unknown[]>;
  listExperiences(): Promise<unknown[]>;
}

export function createGetMaterialsHandler(dependencies: GetMaterialsRouteDependencies) {
  return async function getMaterials() {
    await dependencies.initDatabase();
    const items = await dependencies.listMaterials();
    const facts = await dependencies.listFacts();
    const experiences = await dependencies.listExperiences();
    return NextResponse.json({ materials: items, facts, experiences });
  };
}

export const GET = createGetMaterialsHandler({
  initDatabase,
  listMaterials: () => db.select().from(materials).orderBy(desc(materials.createdAt)),
  listFacts: () => db.select().from(profileFacts),
  listExperiences: () => db.select().from(profileExperiences),
});

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
      reserveContentHash: reserveMaterialHash,
      releaseContentHash: releaseMaterialHashReservation,
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
      extractSmartProfile: extractSmartMaterialProfile,
      persistCreated: persistReservedMaterial,
      createId: randomUUID,
      now: Date.now,
    });

    const conflict = materialConflictResponse(result);
    if (conflict) return conflict;
    if (result.kind !== "created") throw new Error("材料哈希预留状态不一致");
    return materialCreatedResponse(result, { name: file.name, category });

  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "材料解析失败",
    }, { status: 400 });
  }
}
