import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { materialChunks, materials, profileFacts } from "@/db/schema";
import { chunkMaterial } from "@/domain/materials";
import { extractFacts, parseMaterial } from "@/lib/material-parser";
import { resolveLocalStorageRoot } from "@/lib/local-storage";

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
    if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "单个文件不能超过 20MB" }, { status: 413 });

    const id = crypto.randomUUID();
    const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
    const directory = resolve(resolveLocalStorageRoot(), "uploads", id);
    const filePath = resolve(directory, safeName);
    await mkdir(directory, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    const pages = await parseMaterial(file.name, file.type, buffer);
    const chunks = chunkMaterial({ materialId: id, source: file.name, pages });
    const facts = extractFacts(pages, file.name, id);
    await initDatabase();
    await db.insert(materials).values({
      id, name: file.name, category, mimeType: file.type || "application/octet-stream",
      filePath, status: "ready", createdAt: Date.now(),
    });
    if (chunks.length) await db.insert(materialChunks).values(chunks.map((chunk) => ({
      ...chunk,
      start: chunk.position?.start ?? 0,
      end: chunk.position?.end ?? chunk.text.length,
    })));
    if (facts.length) await db.insert(profileFacts).values(facts);
    return NextResponse.json({ material: { id, name: file.name, category }, pages: pages.length, chunks: chunks.length, facts }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "材料解析失败" }, { status: 400 });
  }
}
