import { describe, expect, it } from "vitest";
import { chunkMaterial, selectRelevantChunks } from "./materials";

describe("material retrieval", () => {
  it("keeps source locations when chunking", () => {
    const chunks = chunkMaterial({
      materialId: "m1",
      source: "通信原理笔记.md",
      pages: [{ page: 1, text: "第一段。\n\n第二段。" }],
    });

    expect(chunks).toEqual([
      expect.objectContaining({ materialId: "m1", source: "通信原理笔记.md", page: 1, text: "第一段。" }),
      expect.objectContaining({ materialId: "m1", source: "通信原理笔记.md", page: 1, text: "第二段。" }),
    ]);
  });

  it("returns only the most relevant minimal snippets", () => {
    const chunks = [
      { id: "1", materialId: "m", source: "notes", page: 1, text: "奈奎斯特采样定理与频谱混叠" },
      { id: "2", materialId: "m", source: "notes", page: 2, text: "单片机中断与定时器" },
      { id: "3", materialId: "m", source: "notes", page: 3, text: "采样频率必须满足条件" },
    ];

    expect(selectRelevantChunks(chunks, "采样频率", 2).map((item) => item.id)).toEqual(["3", "1"]);
  });
});
