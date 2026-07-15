import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, initDatabase } from "@/db/client";
import { materialChunks, materials, profileExperiences, profileFacts } from "@/db/schema";
import { retrySmartExtraction } from "@/lib/material-ingestion";
import { normalizeExperienceTitle } from "@/lib/experience-normalization";
import { extractSmartMaterialProfile } from "@/lib/material-smart-extraction";

export const runtime = "nodejs";

async function withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !/SQLITE_BUSY|database is locked/i.test(error.message)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

const materialWrites = new Map<string, Promise<void>>();

async function withMaterialWriteLock<T>(materialId: string, operation: () => Promise<T>): Promise<T> {
  const previous = materialWrites.get(materialId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  materialWrites.set(materialId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (materialWrites.get(materialId) === current) materialWrites.delete(materialId);
  }
}

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
        const [chunks, facts, experiences] = await Promise.all([
          db.select().from(materialChunks).where(eq(materialChunks.materialId, id)),
          db.select().from(profileFacts).where(eq(profileFacts.materialId, id)),
          db.select().from(profileExperiences).where(eq(profileExperiences.materialId, id)),
        ]);
        return {
          id: material.id,
          name: material.name,
          category: material.category,
          parseStatus: material.parseStatus,
          chunks: chunks.map((chunk) => ({ page: chunk.page, start: chunk.start, text: chunk.text })),
          experiences,
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
      extractSmartProfile: extractSmartMaterialProfile,
      persistRetry: async ({ materialId: id, parseStatus, facts, experienceUpdates, experienceInserts }) => {
        await withMaterialWriteLock(id, () => withBusyRetry(() => db.transaction(async (tx) => {
          if (facts.length) await tx.insert(profileFacts).values(facts);
          for (const experience of experienceUpdates) {
            await tx.update(profileExperiences).set({
              type: experience.type,
              title: experience.title,
              normalizedKey: normalizeExperienceTitle(experience.title),
              background: experience.background,
              responsibilities: experience.responsibilities,
              methods: experience.methods,
              results: experience.results,
              awardRole: experience.awardRole,
              source: experience.source,
              page: experience.page,
              evidence: experience.evidence,
              confidence: experience.confidence,
              updatedAt: experience.updatedAt,
            }).where(and(
              eq(profileExperiences.id, experience.id),
              eq(profileExperiences.materialId, id),
              eq(profileExperiences.status, "draft"),
            ));
          }
          if (experienceInserts.length) {
            await tx.insert(profileExperiences).values(experienceInserts.map((experience) => ({
              ...experience,
              normalizedKey: normalizeExperienceTitle(experience.title),
            }))).onConflictDoNothing();
          }
          await tx.update(materials).set({ parseStatus }).where(eq(materials.id, id));
        })));
      },
      createId: randomUUID,
      now: Date.now,
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
