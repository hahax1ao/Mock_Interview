import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface MaterialDeletionInput {
  storageRoot: string;
  materialId: string;
  filePath: string;
}

function resolveUploadDirectory({ storageRoot, materialId, filePath }: MaterialDeletionInput) {
  const uploadsRoot = resolve(storageRoot, "uploads");
  const uploadDirectory = resolve(uploadsRoot, materialId);
  const resolvedFilePath = resolve(filePath);
  const fileRelativeToUpload = relative(uploadDirectory, resolvedFilePath);
  const uploadRelativeToRoot = relative(uploadsRoot, uploadDirectory);

  const escapes = (value: string) =>
    value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);

  if (
    !materialId
    || escapes(uploadRelativeToRoot)
    || uploadRelativeToRoot.includes(sep)
    || basename(uploadDirectory) !== materialId
    || !fileRelativeToUpload
    || escapes(fileRelativeToUpload)
    || basename(dirname(resolvedFilePath)) !== materialId
    || dirname(resolvedFilePath) !== uploadDirectory
  ) {
    throw new Error("Invalid material path: outside the material upload directory");
  }

  return uploadDirectory;
}

export async function deleteMaterialSafely(
  input: MaterialDeletionInput,
  deleteRecord: () => Promise<void>,
): Promise<{ cleanupPending: boolean }> {
  const uploadDirectory = resolveUploadDirectory(input);
  const trashRoot = resolve(input.storageRoot, "trash");
  const quarantineDirectory = join(trashRoot, `${input.materialId}-${randomUUID()}`);

  await mkdir(trashRoot, { recursive: true });
  await rename(uploadDirectory, quarantineDirectory);

  try {
    await deleteRecord();
  } catch (error) {
    await rename(quarantineDirectory, uploadDirectory);
    throw error;
  }

  try {
    await rm(quarantineDirectory, { recursive: true, force: true });
    return { cleanupPending: false };
  } catch {
    return { cleanupPending: true };
  }
}

export async function cleanupMaterialTrash(storageRoot: string): Promise<void> {
  const trashRoot = resolve(storageRoot, "trash");
  await mkdir(trashRoot, { recursive: true });
  const entries = await readdir(trashRoot);
  await Promise.all(entries.map((entry) => rm(join(trashRoot, entry), { recursive: true, force: true })));
}
