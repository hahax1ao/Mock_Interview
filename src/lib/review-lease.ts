import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews } from "@/db/schema";

const LEASE_MS = 10 * 60_000;

export async function acquireReviewLease(interviewId: string, now = Date.now()) {
  await initDatabase();
  const result = await db.update(interviews)
    .set({ reviewLeaseUntil: now + LEASE_MS })
    .where(and(
      eq(interviews.id, interviewId),
      or(isNull(interviews.reviewLeaseUntil), lt(interviews.reviewLeaseUntil, now)),
    ));
  return result.rowsAffected === 1;
}

export async function releaseReviewLease(interviewId: string) {
  await initDatabase();
  await db.update(interviews).set({ reviewLeaseUntil: null }).where(eq(interviews.id, interviewId));
}