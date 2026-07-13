import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, initDatabase } from "@/db/client";
import { profileFacts } from "@/db/schema";

const bodySchema = z.object({
  facts: z.array(z.object({ id: z.string(), value: z.string().min(1).optional(), confirmed: z.boolean() })).min(1),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: materialId } = await params;
    const body = bodySchema.parse(await request.json());
    await initDatabase();
    for (const fact of body.facts) {
      await db.update(profileFacts)
        .set({ ...(fact.value ? { value: fact.value } : {}), confirmed: fact.confirmed })
        .where(and(eq(profileFacts.id, fact.id), eq(profileFacts.materialId, materialId)));
    }
    const facts = await db.select().from(profileFacts).where(eq(profileFacts.materialId, materialId));
    return NextResponse.json({ facts });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "画像确认失败" }, { status: 400 });
  }
}
