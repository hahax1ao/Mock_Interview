import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface MaterialHashRow {
  id: string;
  filePath: string;
  contentHash: string | null;
}

export function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function backfillMaterialHashes(
  rows: MaterialHashRow[],
  update: (id: string, hash: string) => Promise<void>,
): Promise<MaterialHashRow[]> {
  return Promise.all(rows.map(async (row) => {
    if (row.contentHash) return row;
    try {
      const contentHash = sha256(await readFile(row.filePath));
      await update(row.id, contentHash);
      return { ...row, contentHash };
    } catch {
      return row;
    }
  }));
}
