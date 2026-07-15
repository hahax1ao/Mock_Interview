import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, initDatabase } from "@/db/client";
import { profileExperiences } from "@/db/schema";
import { normalizeExperienceTitle } from "@/lib/experience-normalization";
import {
  experienceEditableSchema,
  type ExperienceEditable,
  type ProfileExperience,
} from "@/domain/experiences";

export const runtime = "nodejs";

export interface PatchExperienceRouteDependencies {
  initDatabase(): Promise<void>;
  now(): number;
  updateExperience(
    id: string,
    editable: ExperienceEditable,
    normalizedKey: string,
    status: "draft",
    updatedAt: number,
  ): Promise<ProfileExperience | undefined>;
}

export function createPatchExperienceHandler(dependencies: PatchExperienceRouteDependencies) {
  return async function patchExperience(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
  ) {
    try {
      const { id } = await params;
      const editable = experienceEditableSchema.parse(await request.json());
      await dependencies.initDatabase();
      const experience = await dependencies.updateExperience(
        id, editable, normalizeExperienceTitle(editable.title), "draft", dependencies.now(),
      );
      if (!experience) {
        return NextResponse.json({ error: "Experience not found" }, { status: 404 });
      }
      return NextResponse.json({ experience });
    } catch (error) {
      if (error instanceof Error && /SQLITE_CONSTRAINT|UNIQUE constraint|draft_key_unique/i.test(error.message)) {
        return NextResponse.json({
          error: "Experience title conflicts with another draft",
        }, { status: 409 });
      }
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Experience update failed",
      }, { status: 400 });
    }
  };
}

export const PATCH = createPatchExperienceHandler({
  initDatabase,
  now: Date.now,
  updateExperience: async (id, editable, normalizedKey, status, updatedAt) => {
    const [experience] = await db.update(profileExperiences)
      .set({ ...editable, normalizedKey, status, updatedAt })
      .where(eq(profileExperiences.id, id))
      .returning();
    return experience;
  },
});
