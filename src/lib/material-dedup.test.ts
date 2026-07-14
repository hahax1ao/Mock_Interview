import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { backfillMaterialHashes, sha256 } from "./material-dedup";

const fixture = __filename;

describe("material content hashes", () => {
  it("uses content rather than filename for duplicate identity", () => {
    expect(sha256(Buffer.from("same"))).toBe(sha256(Buffer.from("same")));
    expect(sha256(Buffer.from("same"))).not.toBe(sha256(Buffer.from("different")));
  });

  it("backfills only readable legacy rows with missing hashes", async () => {
    const updates: Array<[string, string]> = [];
    const unreadable = `${fixture}.missing`;
    const rows = await backfillMaterialHashes([
      { id: "old", filePath: fixture, contentHash: null },
      { id: "done", filePath: fixture, contentHash: "known" },
      { id: "missing", filePath: unreadable, contentHash: null },
    ], async (id, hash) => { updates.push([id, hash]); });

    expect(updates).toEqual([["old", sha256(await readFile(fixture))]]);
    expect(rows.find((row) => row.id === "old")?.contentHash).toBe(updates[0]?.[1]);
    expect(rows.find((row) => row.id === "done")?.contentHash).toBe("known");
    expect(rows.find((row) => row.id === "missing")?.contentHash).toBeNull();
  });

  it("does not swallow a database failure while backfilling a readable file", async () => {
    await expect(backfillMaterialHashes([
      { id: "old", filePath: fixture, contentHash: null },
    ], async () => { throw new Error("database unavailable"); })).rejects.toThrow("database unavailable");
  });
});
