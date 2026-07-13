import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, initDatabase } from "./client";
import { interviewEvents, interviews, reviewReports } from "./schema";

describe("interview cascade deletion", () => {
  it("removes transcripts and derived review reports", async () => {
    await initDatabase();
    const id = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    await db.insert(interviews).values({
      id, status: "finished", duration: 10, focus: "cascade-test", pressure: "adaptive",
      materialIds: [], plan: [], createdAt: Date.now(),
    });
    await db.insert(interviewEvents).values({
      id: eventId, interviewId: id, type: "transcript", payload: { text: "test" }, createdAt: Date.now(),
    });
    await db.insert(reviewReports).values({
      id: reportId, interviewId: id, status: "complete", report: {}, createdAt: Date.now(), updatedAt: Date.now(),
    });

    await db.delete(interviews).where(eq(interviews.id, id));

    expect(await db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, id))).toHaveLength(0);
    expect(await db.select().from(reviewReports).where(eq(reviewReports.interviewId, id))).toHaveLength(0);
  });

  it("deduplicates a retried event with the same client id", async () => {
    await initDatabase();
    const interviewId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await db.insert(interviews).values({
      id: interviewId, status: "active", duration: 10, focus: "retry-test", pressure: "adaptive",
      materialIds: [], plan: [], createdAt: Date.now(),
    });
    const event = { id: eventId, interviewId, type: "transcript", payload: { text: "once" }, createdAt: Date.now() };
    await db.insert(interviewEvents).values(event).onConflictDoNothing();
    await db.insert(interviewEvents).values(event).onConflictDoNothing();
    expect(await db.select().from(interviewEvents).where(eq(interviewEvents.interviewId, interviewId))).toHaveLength(1);
    await db.delete(interviews).where(eq(interviews.id, interviewId));
  });});
