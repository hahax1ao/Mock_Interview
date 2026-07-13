import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews } from "@/db/schema";
import { acquireReviewLease, releaseReviewLease } from "./review-lease";

const id = "00000000-0000-4000-8000-000000000099";
afterEach(async () => { await db.delete(interviews).where(eq(interviews.id, id)); });

describe("review lease", () => {
  it("allows only one concurrent reviewer and can be released", async () => {
    await initDatabase();
    await db.insert(interviews).values({ id, status: "finished", duration: 10, focus: "test", pressure: "adaptive", materialIds: [], plan: [], createdAt: Date.now() });
    const results = await Promise.all([acquireReviewLease(id), acquireReviewLease(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await releaseReviewLease(id);
    expect(await acquireReviewLease(id)).toBe(true);
  });
});