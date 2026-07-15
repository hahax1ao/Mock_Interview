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

export interface ConfirmExperienceRouteDependencies {
  initDatabase(): Promise<void>;
  now(): number;
  confirmExperience(
    id: string,
    editable: ExperienceEditable,
    status: "confirmed",
    updatedAt: number,
  ): Promise<ProfileExperience | undefined>;
}

export function createConfirmExperienceHandler(dependencies: ConfirmExperienceRouteDependencies) {
  return async function confirmExperience(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
  ) {
    try {
      const { id } = await params;
      const editable = experienceEditableSchema.parse(await request.json());
      await dependencies.initDatabase();
      const experience = await dependencies.confirmExperience(
        id,
        editable,
        "confirmed",
        dependencies.now(),
      );
      if (!experience) {
        return NextResponse.json({ error: "Experience not found" }, { status: 404 });
      }
      return NextResponse.json({ experience });
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Experience confirmation failed",
      }, { status: 400 });
    }
  };
}

export const POST = createConfirmExperienceHandler({
  initDatabase,
  now: Date.now,
  confirmExperience: async (id, editable, status, updatedAt) => {
    const [experience] = await db.update(profileExperiences)
      .set({ ...editable, status, updatedAt })
      .where(eq(profileExperiences.id, id))
      .returning();
    return experience;
  },
});
