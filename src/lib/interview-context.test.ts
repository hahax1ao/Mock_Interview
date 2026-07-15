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

  it("prepends full confirmed experience details before ordinary facts and excerpts", () => {
    const methods = `CFO 补偿、滑动窗口 De-chirp 解调与 ${"完整方法".repeat(220)}`;
    const results = "吞吐量提升至 1.35 倍，SNR 为 -12dB 时误包率低于 5%";
    const context = formatInterviewContext({
      focus: "通信与信号处理",
      experiences: [{
        id: "core",
        materialId: "material-1",
        type: "research" as const,
        title: "高吞吐量通信协议研究",
        background: "解决数据密集型 IoT 场景的速率限制",
        responsibilities: "完成物理层驱动与 SDR 链路验证",
        methods,
        results,
        awardRole: "",
        source: "resume.pdf",
        page: 2,
        evidence: { title: "高吞吐量通信协议研究" },
        confidence: 0.96,
        status: "confirmed" as const,
        createdAt: 20,
        updatedAt: 20,
      }],
      facts: [{ field: "方向", value: "通信", source: "resume.pdf 第 1 页", confirmed: true }],
      chunks: [{ source: "resume.pdf", page: 2, text: `${"原始材料".repeat(210)}${methods}${results}` }],
    });

    expect(context).toContain("高吞吐量通信协议研究");
    expect(context).toContain("个人职责：完成物理层驱动与 SDR 链路验证");
    expect(context).toContain(methods);
    expect(context).toContain(results);
    expect(context).toContain("来源：resume.pdf 第 2 页");
    expect(context.indexOf("【已确认核心经历】")).toBeLessThan(context.indexOf("画像："));
    expect(context.indexOf("【已确认核心经历】")).toBeLessThan(context.indexOf("资料："));
  });

  it("labels only the selected first confirmed card as core", () => {
    const base = {
      materialId: "material-1",
      type: "research" as const,
      background: "背景",
      responsibilities: "职责",
      methods: "方法",
      results: "结果",
      awardRole: "",
      source: "resume.pdf",
      page: 1,
      confidence: 0.9,
      createdAt: 1,
      updatedAt: 1,
    };
    const context = formatInterviewContext({
      focus: "通信",
      experiences: [
        { ...base, id: "vision", title: "视觉分类", evidence: { title: "视觉分类" }, status: "confirmed" as const },
        { ...base, id: "draft", title: "通信草稿", evidence: { title: "通信草稿" }, status: "draft" as const },
        { ...base, id: "communications", title: "通信协议", evidence: { title: "通信协议" }, status: "confirmed" as const },
      ],
      facts: [],
      chunks: [],
    });

    expect(context.match(/【已确认核心经历】/g)).toHaveLength(1);
    expect(context).toContain("【已确认经历】 类型：科研 名称：视觉分类");
    expect(context.indexOf("通信协议")).toBeLessThan(context.indexOf("视觉分类"));
    expect(context).not.toContain("通信草稿");
  });
});
