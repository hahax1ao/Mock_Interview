import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews, reviewReports } from "@/db/schema";
import { runReview } from "@/lib/review";
import { acquireReviewLease, releaseReviewLease } from "@/lib/review-lease";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await initDatabase();
  const [latest] = await db.select().from(reviewReports).where(eq(reviewReports.interviewId, id)).orderBy(desc(reviewReports.updatedAt)).limit(1);
  return latest
    ? NextResponse.json({ report: latest.report ?? null, status: latest.status, error: latest.error })
    : NextResponse.json({ error: "暂无复盘" }, { status: 404 });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await initDatabase();
  const [interview] = await db.select().from(interviews).where(eq(interviews.id, id));
  if (!interview || !["finished", "reviewed"].includes(interview.status)) return NextResponse.json({ error: "场次尚未结束" }, { status: 409 });
  const [latest] = await db.select().from(reviewReports).where(eq(reviewReports.interviewId, id)).orderBy(desc(reviewReports.updatedAt)).limit(1);
  if (latest?.status === "complete" && latest.report) return NextResponse.json({ report: latest.report });
  if (!await acquireReviewLease(id)) return NextResponse.json({ error: "复盘已在运行，请稍后重试" }, { status: 409 });

  const now = Date.now();
  const reportId = crypto.randomUUID();
  try {
    await db.insert(reviewReports).values({ id: reportId, interviewId: id, status: "running", createdAt: now, updatedAt: now });
    const report = await runReview(id);
    await db.update(reviewReports).set({ status: report.incomplete ? "incomplete" : "complete", report, updatedAt: Date.now() }).where(eq(reviewReports.id, reportId));
    await db.update(interviews).set({ status: "reviewed" }).where(eq(interviews.id, id));
    return NextResponse.json({ report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "复盘失败";
    await db.update(reviewReports).set({ status: "failed", error: message, updatedAt: Date.now() }).where(eq(reviewReports.id, reportId));
    return NextResponse.json({ error: message, retryable: true }, { status: 502 });
  } finally {
    await releaseReviewLease(id);
  }
}