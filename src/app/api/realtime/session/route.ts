import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { interviews } from "@/db/schema";
import { buildResearchHandoffInstruction } from "@/lib/experience-interview";
import { issueRealtimeToken } from "@/lib/realtime-tokens";
import { isQwenConfigured } from "@/lib/qwen";
import { loadQuestionControlSessionState } from "@/lib/question-control-store";

const schema = z.object({ interviewId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const { interviewId } = schema.parse(await request.json());
    if (!isQwenConfigured()) return NextResponse.json({ error: "请先在 .env.local 配置百炼 API Key" }, { status: 503 });
    await initDatabase();
    const [interview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    if (!interview || !["ready", "active"].includes(interview.status)) {
      return NextResponse.json({ error: "场次不存在或状态不允许连接" }, { status: 409 });
    }
    const credential = issueRealtimeToken(interviewId);
    const [research, controlState] = await Promise.all([
      buildResearchHandoffInstruction(interviewId),
      loadQuestionControlSessionState(interviewId),
    ]);
    return NextResponse.json({
      ...credential,
      websocketPath: `/realtime?token=${credential.token}`,
      duration: interview.duration,
      questionControls: controlState.controls,
      pendingControl: controlState.pendingControl,
      roleInstructions: { ...(research ? { research } : {}) },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建实时会话失败" }, { status: 400 });
  }
}
