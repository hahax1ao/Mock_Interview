import { createClient } from "@libsql/client";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrateLegacyDatabase, resolveLocalStorageRoot } from "@/lib/local-storage";
import { cleanupMaterialTrash } from "@/lib/material-deletion";
import { reconcileMaterialHashReservations } from "@/lib/material-reservations";
import { planLegacyDraftKeys } from "@/lib/experience-normalization";

const storageRoot = resolveLocalStorageRoot();
const databasePath = join(storageRoot, "baoyan.db");
const legacyDatabasePath = join(process.cwd(), "data", "baoyan.db");
mkdirSync(dirname(databasePath), { recursive: true });
migrateLegacyDatabase(legacyDatabasePath, databasePath);

const client = createClient({ url: `file:${databasePath}` });
export const db = drizzle(client, { schema });

export async function backfillExperienceNormalizedKeys() {
  const rows = await db.select().from(schema.profileExperiences);
  const planned = planLegacyDraftKeys(rows);
  for (const [id, normalizedKey] of planned) {
    await db.update(schema.profileExperiences)
      .set({ normalizedKey })
      .where(and(
        eq(schema.profileExperiences.id, id),
        isNull(schema.profileExperiences.normalizedKey),
      ));
  }
}

let initialized: Promise<void> | undefined;

export function initDatabase() {
  initialized ??= (async () => {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, mime_type TEXT NOT NULL,
        file_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS material_hash_reservations (
        content_hash TEXT PRIMARY KEY, material_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'committed', lease_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS material_chunks (
        id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        source TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_facts (
        id TEXT PRIMARY KEY, material_id TEXT REFERENCES materials(id) ON DELETE CASCADE,
        field TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, confidence REAL NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS profile_experiences (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        normalized_key TEXT,
        background TEXT NOT NULL DEFAULT '',
        responsibilities TEXT NOT NULL DEFAULT '',
        methods TEXT NOT NULL DEFAULT '',
        results TEXT NOT NULL DEFAULT '',
        award_role TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        page INTEGER NOT NULL,
        evidence TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interviews (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, duration INTEGER NOT NULL, focus TEXT NOT NULL,
        pressure TEXT NOT NULL, material_ids TEXT NOT NULL, plan TEXT NOT NULL,
        started_at INTEGER, finished_at INTEGER, review_lease_until INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interview_events (
        id TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_reports (
        id TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        status TEXT NOT NULL, report TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    const migrations = [
      "ALTER TABLE material_hash_reservations ADD COLUMN state TEXT NOT NULL DEFAULT 'committed'",
      "ALTER TABLE material_hash_reservations ADD COLUMN lease_until INTEGER",
      "ALTER TABLE interviews ADD COLUMN review_lease_until INTEGER",
      "ALTER TABLE materials ADD COLUMN content_hash TEXT",
      "ALTER TABLE materials ADD COLUMN parse_status TEXT DEFAULT 'ready'",
      "ALTER TABLE profile_facts ADD COLUMN evidence TEXT DEFAULT ''",
      "ALTER TABLE profile_facts ADD COLUMN page INTEGER DEFAULT 1",
      "ALTER TABLE profile_facts ADD COLUMN extractor TEXT DEFAULT 'local'",
      "ALTER TABLE profile_experiences ADD COLUMN normalized_key TEXT",
    ];
    for (const migration of migrations) {
      try {
        await client.execute(migration);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
      }
    }
    await backfillExperienceNormalizedKeys();
    await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS profile_experiences_draft_key_unique ON profile_experiences(material_id, type, normalized_key) WHERE status = 'draft' AND normalized_key IS NOT NULL");
    await reconcileMaterialHashReservations();
    try {
      await cleanupMaterialTrash(storageRoot);
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : typeof error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Material trash cleanup failed: ${errorClass}: ${message}`);
    }
  })();
  return initialized;
}
