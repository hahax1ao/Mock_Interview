import { NextResponse } from "next/server";
import { desc, inArray } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews, materials } from "@/db/schema";
import { createInterviewPlan } from "@/domain/interview-plan";
import { InterviewConfigSchema } from "@/domain/schemas";

export async function GET() {
  await initDatabase();
  const items = await db.select().from(interviews).orderBy(desc(interviews.createdAt)).limit(20);
  return NextResponse.json({ interviews: items });
}

export async function POST(request: Request) {
  try {
    const config = InterviewConfigSchema.parse(await request.json());
    const id = crypto.randomUUID();
    const plan = createInterviewPlan(config.duration);
    await initDatabase();
    if (config.materialIds.length) {
      const selected = await db.select({ id: materials.id }).from(materials).where(inArray(materials.id, config.materialIds));
      if (selected.length !== new Set(config.materialIds).size) throw new Error("所选材料不存在或已删除");
    }
    await db.insert(interviews).values({
      id, status: "ready", duration: config.duration, focus: config.focus,
      pressure: config.pressure, materialIds: config.materialIds, plan, createdAt: Date.now(),
    });
    return NextResponse.json({ interview: { id, status: "ready", ...config }, plan }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建场次失败" }, { status: 400 });
  }
}
