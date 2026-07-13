import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { interviewEvents, interviews } from "@/db/schema";
import { InterviewEventSchema } from "@/domain/schemas";

const bodySchema = z.object({ events: z.array(InterviewEventSchema).min(1).max(100) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { events } = bodySchema.parse(await request.json());
    await initDatabase();
    const [interview] = await db.select().from(interviews).where(eq(interviews.id, id));
    if (!interview) return NextResponse.json({ error: "场次不存在" }, { status: 404 });
    if (interview.status === "finished" || interview.status === "reviewed") {
      return NextResponse.json({ error: "已结束场次不能追加事件" }, { status: 409 });
    }
    await db.insert(interviewEvents).values(events.map((event) => ({
      id: event.id ?? crypto.randomUUID(), interviewId: id, type: event.type, payload: event.payload, createdAt: Date.now(),
    }))).onConflictDoNothing();
    if (interview.status === "ready") await db.update(interviews).set({ status: "active", startedAt: Date.now() }).where(eq(interviews.id, id));
    return NextResponse.json({ saved: events.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存事件失败" }, { status: 400 });
  }
}
