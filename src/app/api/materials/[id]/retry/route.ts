import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, initDatabase } from "@/db/client";
import { materialChunks, materials, profileFacts } from "@/db/schema";
import { retrySmartExtraction } from "@/lib/material-ingestion";
import { extractSmartFacts } from "@/lib/material-smart-extraction";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: materialId } = await params;
    await initDatabase();
    const result = await retrySmartExtraction(materialId, {
      loadMaterial: async (id) => {
        const [material] = await db.select().from(materials).where(eq(materials.id, id));
        if (!material) return undefined;
        const [chunks, facts] = await Promise.all([
          db.select().from(materialChunks).where(eq(materialChunks.materialId, id)),
          db.select().from(profileFacts).where(eq(profileFacts.materialId, id)),
        ]);
        return {
          id: material.id,
          name: material.name,
          category: material.category,
          parseStatus: material.parseStatus,
          chunks: chunks.map((chunk) => ({ page: chunk.page, text: chunk.text })),
          facts: facts.map((fact) => ({
            field: fact.field,
            value: fact.value,
            source: fact.source,
            confidence: fact.confidence,
            evidence: fact.evidence ?? "",
            page: fact.page ?? 1,
            extractor: fact.extractor ?? "local",
          })),
        };
      },
      extractSmartFacts,
      persistRetry: async ({ materialId: id, parseStatus, facts }) => {
        await db.transaction(async (tx) => {
          if (facts.length) await tx.insert(profileFacts).values(facts);
          await tx.update(materials).set({ parseStatus }).where(eq(materials.id, id));
        });
      },
      createId: randomUUID,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "智能提取重试失败";
    const status = message === "材料不存在" ? 404
      : message === "仅个人材料支持智能提取" ? 400
      : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
