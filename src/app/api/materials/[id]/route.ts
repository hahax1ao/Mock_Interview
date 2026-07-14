import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, initDatabase } from "@/db/client";
import { materialHashReservations, materials } from "@/db/schema";
import {
  deleteMaterialSafely,
  type MaterialDeletionInput,
} from "@/lib/material-deletion";
import { resolveLocalStorageRoot } from "@/lib/local-storage";

export const runtime = "nodejs";

type DeletableMaterial = {
  id: string;
  name: string;
  filePath: string;
  contentHash: string | null;
};

export interface DeleteMaterialRouteDependencies {
  initDatabase(): Promise<void>;
  findMaterial(id: string): Promise<DeletableMaterial | undefined>;
  storageRoot(): string;
  deleteSafely(
    input: MaterialDeletionInput,
    deleteRecord: () => Promise<void>,
  ): Promise<{ cleanupPending: boolean }>;
  deleteRecord(material: DeletableMaterial): Promise<void>;
}

function deletionError(error: unknown) {
  if (error instanceof Error && /invalid material path/i.test(error.message)) {
    return NextResponse.json({
      error: "材料路径无效",
      errorClass: "InvalidMaterialPath",
      message: "材料文件路径不合法",
    }, { status: 400 });
  }
  const errorClass = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "Error";
  return NextResponse.json({
    error: "材料删除失败",
    errorClass,
    message: "数据库或文件操作失败",
  }, { status: 500 });
}

export function createDeleteMaterialHandler(dependencies: DeleteMaterialRouteDependencies) {
  return async function deleteMaterial(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
  ) {
    try {
      const { id: materialId } = await params;
      await dependencies.initDatabase();
      const material = await dependencies.findMaterial(materialId);
      if (!material) {
        return NextResponse.json({ error: "Material not found" }, { status: 404 });
      }

      const { cleanupPending } = await dependencies.deleteSafely({
        storageRoot: dependencies.storageRoot(),
        materialId,
        filePath: material.filePath,
      }, () => dependencies.deleteRecord(material));

      return NextResponse.json({ deletedId: materialId, cleanupPending });
    } catch (error) {
      return deletionError(error);
    }
  };
}

export const deleteMaterial = createDeleteMaterialHandler({
  initDatabase,
  findMaterial: async (materialId) => {
    const [material] = await db.select({
      id: materials.id,
      name: materials.name,
      filePath: materials.filePath,
      contentHash: materials.contentHash,
    }).from(materials).where(eq(materials.id, materialId));
    return material;
  },
  storageRoot: resolveLocalStorageRoot,
  deleteSafely: deleteMaterialSafely,
  deleteRecord: async (material) => {
    await db.transaction(async (tx) => {
      await tx.delete(materials).where(eq(materials.id, material.id));
      if (!material.contentHash) return;

      const [canonical] = await tx.select({
        id: materials.id,
        name: materials.name,
        createdAt: materials.createdAt,
      }).from(materials)
        .where(eq(materials.contentHash, material.contentHash))
        .orderBy(asc(materials.createdAt), asc(materials.id))
        .limit(1);
      if (canonical) {
        await tx.insert(materialHashReservations).values({
          contentHash: material.contentHash,
          materialId: canonical.id,
          name: canonical.name,
          createdAt: canonical.createdAt,
        }).onConflictDoUpdate({
          target: materialHashReservations.contentHash,
          set: {
            materialId: canonical.id,
            name: canonical.name,
            createdAt: canonical.createdAt,
          },
        });
      } else {
        await tx.delete(materialHashReservations)
          .where(eq(materialHashReservations.contentHash, material.contentHash));
      }
    });
  },
});

export { deleteMaterial as DELETE };
