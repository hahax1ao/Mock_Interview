import { describe, expect, it } from "vitest";
import { formatInterviewContext } from "./interview-context";

describe("formatInterviewContext", () => {
  it("includes confirmed facts and traceable material excerpts only", () => {
    const context = formatInterviewContext({
      focus: "信号处理",
      facts: [
        { field: "项目", value: "雷达识别", source: "resume.pdf 第1页", confirmed: true },
        { field: "排名", value: "前10%", source: "resume.pdf 第1页", confirmed: false },
      ],
      chunks: [{ source: "notes.pdf", page: 3, text: "采样定理与频谱混叠" }],
    });
    expect(context).toContain("雷达识别");
    expect(context).not.toContain("前10%");
    expect(context).toContain("notes.pdf 第3页");
  });
});