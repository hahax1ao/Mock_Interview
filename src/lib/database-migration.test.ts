import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
});
