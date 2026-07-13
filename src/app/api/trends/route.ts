import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews, reviewReports } from "@/db/schema";

export async function GET(request: Request) {
  await initDatabase();
  const url = new URL(request.url);
  const duration = Number(url.searchParams.get("duration") ?? 20);
  const focus = url.searchParams.get("focus");
  const pressure = url.searchParams.get("pressure");
  const conditions = [eq(interviews.duration, duration)];
  if (focus) conditions.push(eq(interviews.focus, focus));
  if (pressure) conditions.push(eq(interviews.pressure, pressure));

  const rows = await db.select({
    id: interviews.id,
    focus: interviews.focus,
    pressure: interviews.pressure,
    duration: interviews.duration,
    createdAt: interviews.createdAt,
    report: reviewReports.report,
    reportStatus: reviewReports.status,
    reportUpdatedAt: reviewReports.updatedAt,
  }).from(interviews)
    .innerJoin(reviewReports, eq(reviewReports.interviewId, interviews.id))
    .where(and(...conditions))
    .orderBy(asc(interviews.createdAt));

  const latestComplete = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (row.reportStatus !== "complete") continue;
    const previous = latestComplete.get(row.id);
    if (!previous || row.reportUpdatedAt > previous.reportUpdatedAt) latestComplete.set(row.id, row);
  }
  const points = [...latestComplete.values()].flatMap((row) => {
    const report = row.report as { totalScore?: number; dimensions?: Array<{ dimension: string; score: number }> } | null;
    return typeof report?.totalScore === "number" ? [{
      id: row.id, createdAt: row.createdAt, totalScore: report.totalScore,
      dimensions: report.dimensions ?? [], focus: row.focus, pressure: row.pressure, duration: row.duration,
    }] : [];
  });
  return NextResponse.json({ points, comparableBy: ["duration", "focus", "pressure"] });
}
