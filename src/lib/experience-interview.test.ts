import { describe, expect, it } from "vitest";
import type { ProfileExperience } from "@/domain/experiences";
import { buildResearchHandoffInstruction, formatCoreExperience, selectCoreExperience } from "./experience-interview";
import { db, initDatabase } from "@/db/client";
import { interviews, materials, profileExperiences } from "@/db/schema";
import { eq } from "drizzle-orm";

function experience(overrides: Partial<ProfileExperience>): ProfileExperience {
  return {
    id: "experience-1",
    materialId: "material-1",
    type: "research",
    title: "项目经历",
    background: "背景",
    responsibilities: "职责",
    methods: "方法",
    results: "结果",
    awardRole: "",
    source: "resume.pdf",
    page: 1,
    evidence: { title: "项目经历" },
    confidence: 0.9,
    status: "confirmed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("selectCoreExperience", () => {
  it("prioritizes focus relevance across the title and detail fields", () => {
    const experiences = [
      experience({ id: "vision", title: "视觉分类系统", methods: "卷积网络" }),
      experience({ id: "communications", title: "高吞吐量通信协议研究", methods: "信号处理与 SDR 验证" }),
    ];

    expect(selectCoreExperience(experiences, "通信与信号处理")?.title).toBe("高吞吐量通信协议研究");
  });
  it("uses detail completeness after focus relevance", () => {
    const experiences = [
      experience({ id: "sparse", title: "通信项目", background: "", responsibilities: "", methods: "", results: "" }),
      experience({ id: "complete", title: "通信项目", background: "目标", responsibilities: "职责", methods: "方法", results: "结果" }),
    ];

    expect(selectCoreExperience(experiences, "通信")?.id).toBe("complete");
  });
  it("uses a quantitative result after detail completeness", () => {
    const experiences = [
      experience({ id: "qualitative", title: "通信项目", results: "吞吐量显著提升" }),
      experience({ id: "quantitative", title: "通信项目", results: "吞吐量提升 35%" }),
    ];

    expect(selectCoreExperience(experiences, "通信")?.id).toBe("quantitative");
  });
  it("uses the newest createdAt as a stable score tie-breaker", () => {
    const experiences = [
      experience({ id: "older", title: "通信项目", createdAt: 10 }),
      experience({ id: "newer", title: "通信项目", createdAt: 20 }),
    ];

    expect(selectCoreExperience(experiences, "通信")?.id).toBe("newer");
  });
  it("uses id order as the final stable tie-breaker", () => {
    const experiences = [
      experience({ id: "z-card", title: "通信项目", createdAt: 20 }),
      experience({ id: "a-card", title: "通信项目", createdAt: 20 }),
    ];

    expect(selectCoreExperience(experiences, "通信")?.id).toBe("a-card");
  });
  it("excludes draft experiences", () => {
    const draftOnly = experience({ status: "draft", title: "通信项目" });

    expect(selectCoreExperience([draftOnly], "通信")).toBeUndefined();
  });
});
describe("formatCoreExperience", () => {
  it("formats every structured detail with source traceability", () => {
    const formatted = formatCoreExperience(experience({
      title: "高吞吐量通信协议研究",
      background: "解决数据密集型 IoT 场景的速率限制",
      responsibilities: "完成物理层驱动与 SDR 链路验证",
      methods: "实现 CFO 补偿与滑动窗口 De-chirp 解调",
      results: "吞吐量提升至 1.35 倍，SNR 为 -12dB 时误包率低于 5%",
      awardRole: "第一作者",
      source: "resume.pdf",
      page: 2,
    }));

    expect(formatted).toContain("【已确认核心经历】 类型：科研 名称：高吞吐量通信协议研究");
    expect(formatted).toContain("背景目标：解决数据密集型 IoT 场景的速率限制");
    expect(formatted).toContain("个人职责：完成物理层驱动与 SDR 链路验证");
    expect(formatted).toContain("技术方法：实现 CFO 补偿与滑动窗口 De-chirp 解调");
    expect(formatted).toContain("量化成果：吞吐量提升至 1.35 倍，SNR 为 -12dB 时误包率低于 5%");
    expect(formatted).toContain("奖项角色：第一作者");
    expect(formatted).toContain("来源：resume.pdf 第 2 页");
  });
});
describe("buildResearchHandoffInstruction", () => {
  it("names the selected confirmed experience and fixes the first research question", async () => {
    await initDatabase();
    const interviewId = crypto.randomUUID();
    const materialId = crypto.randomUUID();
    await db.insert(materials).values({ id: materialId, name: "resume.pdf", category: "personal", mimeType: "application/pdf", filePath: "resume.pdf", createdAt: 1 });
    await db.insert(interviews).values({ id: interviewId, status: "ready", duration: 1200, focus: "通信", pressure: "medium", materialIds: [materialId], plan: {}, createdAt: 1 });
    await db.insert(profileExperiences).values(experience({ id: crypto.randomUUID(), materialId, title: "高吞吐量通信协议研究", responsibilities: "负责 SDR 验证", status: "confirmed" }));

    try {
      const instruction = await buildResearchHandoffInstruction(interviewId);
      expect(instruction).toContain("高吞吐量通信协议研究");
      expect(instruction).toContain("科研项目模块的第一问必须点名这项经历并询问候选人的个人职责。");
      expect(instruction).toContain("后续按动机与职责、技术方法、实验结果、局限与改进追问；同一主题最多三层。");
    } finally {
      await db.delete(interviews).where(eq(interviews.id, interviewId));
      await db.delete(materials).where(eq(materials.id, materialId));
    }
  });
});