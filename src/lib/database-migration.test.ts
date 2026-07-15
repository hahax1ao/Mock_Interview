import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyDatabase } from "./local-storage";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
});

describe("legacy SQLite migration", () => {
  it("includes committed rows that are still in the WAL", async () => {
    const root = mkdtempSync(join(tmpdir(), "baoyan-migration-"));
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const { DatabaseSync } = await import("node:sqlite");
    roots.push(root);
    const source = join(root, "legacy.db");
    const target = join(root, "new", "baoyan.db");
    const writer = new DatabaseSync(source);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts (value TEXT); INSERT INTO facts VALUES ('from-wal');");
    expect(existsSync(`${source}-wal`)).toBe(true);

    migrateLegacyDatabase(source, target);

    const migrated = new DatabaseSync(target, { readOnly: true });
    expect(migrated.prepare("SELECT value FROM facts").get()).toEqual({ value: "from-wal" });
    migrated.close();
    writer.close();
  });

  it("adds material hash and parse metadata columns idempotently", async () => {
    const { db, initDatabase } = await import("@/db/client");
    await initDatabase();
    await initDatabase();

    const materialInfo = await db.run(sql`PRAGMA table_info(materials)`);
    const factInfo = await db.run(sql`PRAGMA table_info(profile_facts)`);
    const experienceInfo = await db.run(sql`PRAGMA table_info(profile_experiences)`);
    const reservationInfo = await db.run(sql`PRAGMA table_info(material_hash_reservations)`);
    const materialColumns = Object.fromEntries(materialInfo.rows.map((row) => [row.name, row]));
    const factColumns = Object.fromEntries(factInfo.rows.map((row) => [row.name, row]));
    const reservationColumns = Object.fromEntries(reservationInfo.rows.map((row) => [row.name, row]));

    expect(materialColumns.content_hash).toBeDefined();
    expect(materialColumns.parse_status?.dflt_value).toBe("'ready'");
    expect(factColumns.evidence?.dflt_value).toBe("''");
    expect(factColumns.page?.dflt_value).toBe("1");
    expect(factColumns.extractor?.dflt_value).toBe("'local'");
    expect(reservationColumns.content_hash?.pk).toBe(1);
    expect(reservationColumns.material_id).toBeDefined();
    expect(reservationColumns.state?.notnull).toBe(1);
    expect(reservationColumns.state?.dflt_value).toBe("'committed'");
    expect(reservationColumns.lease_until).toBeDefined();
    expect(experienceInfo.rows.map((column) => column.name)).toEqual(expect.arrayContaining([
      "id", "material_id", "type", "title", "background", "responsibilities",
      "methods", "results", "award_role", "source", "page", "evidence",
      "confidence", "status", "created_at", "updated_at",
    ]));
  });
  it("backfills duplicate draft keys without deleting legacy rows", async () => {
    const { db, initDatabase, backfillExperienceNormalizedKeys } = await import("@/db/client");
    const { materials, profileExperiences } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await initDatabase();
    const materialId = `migration-${crypto.randomUUID()}`;
    await db.insert(materials).values({
      id: materialId, name: "legacy.txt", category: "personal", mimeType: "text/plain",
      filePath: "legacy.txt", status: "ready", contentHash: crypto.randomUUID(),
      parseStatus: "basic_only", createdAt: 1,
    });
    const base = {
      materialId, type: "project" as const, background: "", responsibilities: "", methods: "",
      results: "", awardRole: "", source: "legacy.txt", page: 1,
      evidence: { title: "Atlas" }, confidence: 0.8, status: "draft" as const, createdAt: 1,
    };
    await db.insert(profileExperiences).values([
      { ...base, id: "legacy-old", title: " Atlas ", updatedAt: 10 },
      { ...base, id: "legacy-new", title: "\uFF21\uFF54\uFF4C\uFF41\uFF53", updatedAt: 20 },
    ]);
    try {
      await backfillExperienceNormalizedKeys();
      const rows = await db.select().from(profileExperiences)
        .where(eq(profileExperiences.materialId, materialId));
      expect(rows).toHaveLength(2);
      expect(Object.fromEntries(rows.map((row) => [row.id, row.normalizedKey]))).toEqual({
        "legacy-new": "atlas",
        "legacy-old": "atlas#legacy:legacy-old",
      });
    } finally {
      await db.delete(materials).where(eq(materials.id, materialId));
    }
  });
  it("enforces one database-owned initial research claim per interview", async () => {
    const { db, initDatabase } = await import("@/db/client");
    const { interviewEvents, interviews } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await initDatabase();
    const interviewId = crypto.randomUUID();
    await db.insert(interviews).values({
      id: interviewId, status: "active", duration: 20, focus: "communications",
      pressure: "adaptive", materialIds: [], plan: {}, startedAt: 1, createdAt: 1,
    });
    const claim = (id: string) => db.insert(interviewEvents).values({
      id, interviewId, type: "research_initial_claim",
      payload: { status: "pending", leaseUntil: Date.now() + 120_000 }, createdAt: Date.now(),
    });

    try {
      await claim(crypto.randomUUID());
      await expect(claim(crypto.randomUUID())).rejects.toThrow();
    } finally {
      await db.delete(interviews).where(eq(interviews.id, interviewId));
    }
  });
});
