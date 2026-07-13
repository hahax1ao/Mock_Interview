import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews } from "@/db/schema";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await initDatabase();
  await db.delete(interviews).where(eq(interviews.id, id));
  return NextResponse.json({ deleted: true });
}
