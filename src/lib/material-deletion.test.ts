import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupMaterialTrash, deleteMaterialSafely } from "./material-deletion";
import { resolveLocalStorageRoot } from "./local-storage";

const cleanupFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (cleanupFailure.enabled && String(path).includes(`${join("trash", "material-cleanup")}-`)) {
        throw new Error("trash is busy");
      }
      return actual.rm(path, options);
    },
  };
});

const temporaryRoots: string[] = [];

async function createUpload(materialId: string, name = "resume.pdf") {
  const storageRoot = await mkdtemp(join(tmpdir(), "material-deletion-"));
  temporaryRoots.push(storageRoot);
  const directory = join(storageRoot, "uploads", materialId);
  const filePath = join(directory, name);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, "resume");
  return { storageRoot, directory, filePath };
}

afterEach(async () => {
  cleanupFailure.enabled = false;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("safe material deletion", () => {
  it("quarantines the material upload before deleting its database record", async () => {
    const materialId = "material-normal";
    const upload = await createUpload(materialId);
    let quarantinedPath = "";

    const result = await deleteMaterialSafely({ ...upload, materialId }, async () => {
      const trashEntries = await readdir(join(upload.storageRoot, "trash"));
      expect(trashEntries).toHaveLength(1);
      quarantinedPath = join(upload.storageRoot, "trash", trashEntries[0]);
      expect(trashEntries[0]).toMatch(new RegExp(`^${materialId}-`));
      expect(await readFile(join(quarantinedPath, basename(upload.filePath)), "utf8")).toBe("resume");
    });

    expect(result).toEqual({ cleanupPending: false });
    await expect(readdir(upload.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(quarantinedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a file path outside the exact material upload directory", async () => {
    const materialId = "material-guarded";
    const upload = await createUpload(materialId);
    const outsideDirectory = join(upload.storageRoot, "elsewhere", materialId);
    const outsidePath = join(outsideDirectory, "resume.pdf");
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(outsidePath, "do not delete");
    const deleteRecord = vi.fn();

    await expect(deleteMaterialSafely({ storageRoot: upload.storageRoot, materialId, filePath: outsidePath }, deleteRecord))
      .rejects.toThrow(/outside.*upload|invalid.*path/i);

    expect(deleteRecord).not.toHaveBeenCalled();
    expect(await readFile(outsidePath, "utf8")).toBe("do not delete");
    expect(await readFile(upload.filePath, "utf8")).toBe("resume");
  });

  it("restores the quarantined upload when database deletion fails", async () => {
    const materialId = "material-rollback";
    const upload = await createUpload(materialId);

    await expect(deleteMaterialSafely({ ...upload, materialId }, async () => {
      throw new Error("database unavailable");
    })).rejects.toThrow("database unavailable");

    expect(await readFile(upload.filePath, "utf8")).toBe("resume");
    expect(await readdir(join(upload.storageRoot, "trash"))).toEqual([]);
  });

  it("reports pending cleanup only when the final quarantine removal fails", async () => {
    const materialId = "material-cleanup";
    const upload = await createUpload(materialId);
    cleanupFailure.enabled = true;

    const result = await deleteMaterialSafely({ ...upload, materialId }, async () => undefined);

    expect(result).toEqual({ cleanupPending: true });
    expect(await readdir(join(upload.storageRoot, "trash"))).toHaveLength(1);
  });

  it("removes stale quarantine directories", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "material-trash-"));
    temporaryRoots.push(storageRoot);
    const staleDirectory = join(storageRoot, "trash", "stale-material-old-uuid");
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(join(staleDirectory, "resume.pdf"), "stale");

    await cleanupMaterialTrash(storageRoot);

    expect(await readdir(join(storageRoot, "trash"))).toEqual([]);
  });
});


describe("database initialization trash cleanup", () => {
  it("logs only the cleanup error class and message without blocking startup", async () => {
    const cleanup = vi.fn().mockRejectedValue(new TypeError("trash is busy"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();
    vi.doMock("@/lib/material-deletion", () => ({ cleanupMaterialTrash: cleanup }));

    try {
      const { initDatabase } = await import("@/db/client");
      await expect(initDatabase()).resolves.toBeUndefined();
      expect(cleanup).toHaveBeenCalledWith(resolveLocalStorageRoot());
      expect(errorLog).toHaveBeenCalledWith("Material trash cleanup failed: TypeError: trash is busy");
    } finally {
      errorLog.mockRestore();
      vi.doUnmock("@/lib/material-deletion");
      vi.resetModules();
    }
  });
});
