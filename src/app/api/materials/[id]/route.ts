import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, initDatabase } from "@/db/client";
import { materials } from "@/db/schema";
import { deleteMaterialSafely } from "@/lib/material-deletion";
import { resolveLocalStorageRoot } from "@/lib/local-storage";

export const runtime = "nodejs";

export async function deleteMaterial(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: materialId } = await params;
  await initDatabase();
  const [material] = await db.select().from(materials).where(eq(materials.id, materialId));
  if (!material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  const { cleanupPending } = await deleteMaterialSafely({
    storageRoot: resolveLocalStorageRoot(),
    materialId,
    filePath: material.filePath,
  }, async () => {
    await db.transaction(async (tx) => {
      await tx.delete(materials).where(eq(materials.id, materialId));
    });
  });

  return NextResponse.json({ deletedId: materialId, cleanupPending });
}

export { deleteMaterial as DELETE };
