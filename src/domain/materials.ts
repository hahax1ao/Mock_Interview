export interface MaterialChunk {
  id: string;
  materialId: string;
  source: string;
  page: number;
  text: string;
  position?: { start: number; end: number };
}

export function chunkMaterial(input: {
  materialId: string;
  source: string;
  pages: Array<{ page: number; text: string }>;
}): MaterialChunk[] {
  const chunks: MaterialChunk[] = [];
  for (const page of input.pages) {
    let cursor = 0;
    for (const raw of page.text.split(/\n\s*\n/g)) {
      const text = raw.trim();
      if (!text) continue;
      const start = page.text.indexOf(raw, cursor);
      cursor = start + raw.length;
      chunks.push({
        id: `${input.materialId}:${page.page}:${chunks.length + 1}`,
        materialId: input.materialId,
        source: input.source,
        page: page.page,
        text,
        position: { start, end: start + raw.length },
      });
    }
  }
  return chunks;
}

function relevance(text: string, query: string) {
  const normalized = query.toLowerCase().replace(/\s+/g, "");
  const candidate = text.toLowerCase().replace(/\s+/g, "");
  if (candidate.includes(normalized)) return 100 + normalized.length;
  let score = 0;
  for (let size = Math.min(4, normalized.length); size > 0; size--) {
    for (let i = 0; i <= normalized.length - size; i++) {
      if (candidate.includes(normalized.slice(i, i + size))) score += size * size;
    }
  }
  return score;
}

export function selectRelevantChunks(chunks: MaterialChunk[], query: string, limit = 5) {
  return chunks
    .map((chunk, index) => ({ chunk, index, score: relevance(chunk.text, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ chunk }) => chunk);
}
