import { eq, inArray } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews, materialChunks, profileFacts } from "@/db/schema";
import { selectRelevantChunks } from "@/domain/materials";

type ContextFact = { field: string; value: string; source: string; confirmed: boolean };
type ContextChunk = { source: string; page: number; text: string };

export function formatInterviewContext(input: { focus: string; facts: ContextFact[]; chunks: ContextChunk[] }) {
  const confirmedFacts = input.facts.filter((fact) => fact.confirmed).slice(0, 20);
  const indexed = input.chunks.map((chunk, index) => ({
    id: String(index), materialId: "selected", source: chunk.source, page: chunk.page,
    text: chunk.text, position: { start: 0, end: chunk.text.length },
  }));
  const relevant = selectRelevantChunks(indexed, input.focus, 6);
  const excerpts = (relevant.length ? relevant : indexed.slice(0, 6));
  if (!confirmedFacts.length && !excerpts.length) return "";
  return [
    "\n【用户已选择的本地材料；只能据此引用个人事实】",
    ...confirmedFacts.map((fact) => `画像：${fact.field}=${fact.value}（${fact.source}，已确认）`),
    ...excerpts.map((chunk) => `资料：${chunk.source} 第${chunk.page}页 [片段${chunk.id}] ${chunk.text.slice(0, 800)}`),
    "使用材料追问时保留来源；未确认事实不得当作确定事实。",
  ].join("\n");
}

export async function buildInterviewContext(interviewId: string) {
  await initDatabase();
  const [interview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
  if (!interview || !interview.materialIds.length) return "";
  const [chunks, facts] = await Promise.all([
    db.select().from(materialChunks).where(inArray(materialChunks.materialId, interview.materialIds)),
    db.select().from(profileFacts).where(inArray(profileFacts.materialId, interview.materialIds)),
  ]);
  return formatInterviewContext({ focus: interview.focus, facts, chunks });
}