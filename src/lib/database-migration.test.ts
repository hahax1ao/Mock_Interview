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
  });
});
