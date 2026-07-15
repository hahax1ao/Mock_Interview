import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, initDatabase } from "@/db/client";
import { profileExperiences } from "@/db/schema";
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
      const experience = await dependencies.updateExperience(id, editable, "draft", dependencies.now());
      if (!experience) {
        return NextResponse.json({ error: "Experience not found" }, { status: 404 });
      }
      return NextResponse.json({ experience });
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Experience update failed",
      }, { status: 400 });
    }
  };
}

export const PATCH = createPatchExperienceHandler({
  initDatabase,
  now: Date.now,
  updateExperience: async (id, editable, status, updatedAt) => {
    const [experience] = await db.update(profileExperiences)
      .set({ ...editable, status, updatedAt })
      .where(eq(profileExperiences.id, id))
      .returning();
    return experience;
  },
});
