import { describe, expect, it, vi } from "vitest";
import {
  extractSmartFacts,
  extractSmartMaterialProfile,
  validateSmartEvidence,
  type SmartExtractionInvoke,
} from "./material-smart-extraction";

const pages = [
  { page: 1, text: "竞赛经历\n2025年 全国大学生嵌入式芯片与系统设计竞赛 FPGA赛道 全国二等奖" },
  { page: 2, text: "技能\n熟练使用 SystemVerilog 与 UVM" },
];


const experiencePages = [{ page: 1, text: [
  "高吞吐量通信协议研究与全链路验证",
  "项目目标：解决数据密集型 IoT 速率受限问题。",
  "实现内容：完成物理层驱动、SDR 链路与滑动窗口解调。",
  "结果：有效吞吐量达到标准协议的 1.35 倍。",
  "全国大学生嵌入式芯片与系统设计竞赛",
  "队长，负责 FPGA 与上位机，开发智能会议相机，丢包率小于 1%。",
  "全国大学生电子设计竞赛 G 题",
  "队长，负责 FPGA 与硬件电路，实现未知 RLC 网络识别。",
].join("\n") }];

const researchCard = {
  type: "research" as const, title: "高吞吐量通信协议研究与全链路验证",
  background: "解决数据密集型 IoT 速率受限问题", responsibilities: "",
  methods: "物理层驱动、SDR 链路与滑动窗口解调",
  results: "有效吞吐量达到标准协议的 1.35 倍", awardRole: "", page: 1,
  evidence: {
    title: "高吞吐量通信协议研究与全链路验证",
    background: "数据密集型 IoT 速率受限",
    methods: "物理层驱动、SDR 链路与滑动窗口解调",
    results: "有效吞吐量达到标准协议的 1.35 倍",
  }, confidence: 0.91,
};

const embeddedCard = {
  type: "competition" as const, title: "全国大学生嵌入式芯片与系统设计竞赛",
  background: "", responsibilities: "负责 FPGA 与上位机",
  methods: "开发智能会议相机", results: "丢包率小于 1%", awardRole: "队长", page: 1,
  evidence: {
    title: "全国大学生嵌入式芯片与系统设计竞赛",
    responsibilities: "负责 FPGA 与上位机", methods: "智能会议相机",
    results: "丢包率小于 1%", awardRole: "队长",
  }, confidence: 0.88,
};

const electronicDesignCard = {
  type: "competition" as const, title: "全国大学生电子设计竞赛 G 题",
  background: "", responsibilities: "负责 FPGA 与硬件电路",
  methods: "实现未知 RLC 网络识别", results: "", awardRole: "队长", page: 1,
  evidence: {
    title: "全国大学生电子设计竞赛 G 题",
    responsibilities: "负责 FPGA 与硬件电路",
    methods: "未知 RLC 网络识别", awardRole: "队长",
  }, confidence: 0.86,
};

describe("smart material extraction", () => {
  it("returns three semantically distinct experience cards with all detail fields from one call", async () => {
    const invoke = vi.fn<SmartExtractionInvoke>(async () => ({
      facts: [], experiences: [researchCard, embeddedCard, electronicDesignCard],
    }));
    const result = await extractSmartMaterialProfile(experiencePages, "resume.pdf", invoke);

    expect(result.experiences).toHaveLength(3);
    expect(result.experiences.map((item) => item.type)).toEqual(["research", "competition", "competition"]);
    expect(result.experiences[0].results).toContain("1.35 倍");
    expect(result.experiences[1].responsibilities).toContain("FPGA 与上位机");
    expect(result.experiences[2].methods).toContain("RLC 网络识别");
    expect(result.experiences[0]).toMatchObject({
      title: researchCard.title,
      background: researchCard.background,
      responsibilities: researchCard.responsibilities,
      methods: researchCard.methods,
      results: researchCard.results,
      awardRole: researchCard.awardRole,
      evidence: researchCard.evidence,
      source: "resume.pdf",
    });
    expect(result.experiences[1].awardRole).toBe("队长");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("deduplicates cards by normalized type and title", async () => {
    const duplicate = {
      ...researchCard,
      title: " 高吞吐量通信协议研究与全链路验证 ",
    };
    const result = await extractSmartMaterialProfile(experiencePages, "resume.pdf", async () => ({
      facts: [], experiences: [researchCard, duplicate],
    }));
    expect(result.experiences).toHaveLength(1);
  });

  it("accepts a generic replacement title without a project-name allowlist", async () => {
    const text = "匿名课题甲\n研究脉冲整形方法，最终降低误码率。";
    const result = await extractSmartMaterialProfile([{ page: 7, text }], "generic.pdf", async () => ({
      facts: [], experiences: [{
        type: "research", title: "匿名课题甲", background: "",
        responsibilities: "研究脉冲整形方法", methods: "脉冲整形",
        results: "降低误码率", awardRole: "", page: 7,
        evidence: {
          title: "匿名课题甲", responsibilities: "研究脉冲整形方法",
          methods: "脉冲整形", results: "降低误码率",
        }, confidence: 0.8,
      }],
    }));
    expect(result.experiences).toEqual([expect.objectContaining({ title: "匿名课题甲", source: "generic.pdf" })]);
  });

  it("removes an invented title while retaining a valid card", async () => {
    const invalid = {
      ...researchCard, title: "材料中不存在的项目",
      evidence: { ...researchCard.evidence, title: "材料中不存在的项目" },
    };
    const result = await extractSmartMaterialProfile(experiencePages, "resume.pdf", async () => ({
      facts: [], experiences: [invalid, embeddedCard],
    }));
    expect(result.experiences.map((item) => item.title)).toEqual([embeddedCard.title]);
  });

  it("removes unsupported detail evidence while retaining a valid card", async () => {
    const invalid = {
      ...researchCard, methods: "使用量子算法",
      evidence: { ...researchCard.evidence, methods: "量子算法" },
    };
    const result = await extractSmartMaterialProfile(experiencePages, "resume.pdf", async () => ({
      facts: [], experiences: [invalid, embeddedCard],
    }));
    expect(result.experiences.map((item) => item.title)).toEqual([embeddedCard.title]);
  });

  it("removes an invalid page while retaining a valid card", async () => {
    const result = await extractSmartMaterialProfile(experiencePages, "resume.pdf", async () => ({
      facts: [], experiences: [{ ...researchCard, page: 99 }, embeddedCard],
    }));
    expect(result.experiences.map((item) => item.title)).toEqual([embeddedCard.title]);
  });

  it("rejects a title-only card", async () => {
    const titleOnly = {
      type: "project", title: researchCard.title, background: "", responsibilities: "",
      methods: "", results: "", awardRole: "", page: 1,
      evidence: { title: researchCard.title }, confidence: 0.8,
    };
    await expect(extractSmartMaterialProfile(experiencePages, "resume.pdf", async () => ({
      facts: [], experiences: [titleOnly],
    }))).rejects.toThrow();
  });


  it("accepts exact page-scoped evidence and caps model confidence", async () => {
    const invoke = vi.fn<SmartExtractionInvoke>(async () => ({ facts: [{
      field: "竞赛经历",
      value: "全国大学生嵌入式芯片与系统设计竞赛全国二等奖",
      evidence: "2025年 全国大学生嵌入式芯片与系统设计竞赛 FPGA赛道 全国二等奖",
      page: 1,
      confidence: 0.98,
    }] }));

    const facts = await extractSmartFacts(pages, "jianli.pdf", invoke);

    expect(facts).toEqual([expect.objectContaining({
      field: "竞赛经历",
      source: "jianli.pdf",
      extractor: "qwen",
      page: 1,
      confidence: 0.9,
    })]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][0]).toMatchObject({ model: expect.any(String), schema: expect.any(Object) });
  });

  it("matches evidence after NFKC and whitespace normalization", () => {
    expect(validateSmartEvidence({
      field: "竞赛经历",
      value: "全国二等奖",
      evidence: "２０２５ 年 全 国 大 学 生 嵌 入 式 芯 片 与 系 统 设 计 竞 赛",
      page: 1,
      confidence: 0.9,
    }, pages)).toBe(true);
  });

  it("rejects missing evidence and evidence declared on the wrong page", () => {
    const base = {
      field: "技能" as const,
      value: "SystemVerilog",
      evidence: "熟练使用 SystemVerilog 与 UVM",
      confidence: 0.8,
    };

    expect(validateSmartEvidence({ ...base, evidence: "熟练使用 VHDL", page: 2 }, pages)).toBe(false);
    expect(validateSmartEvidence({ ...base, page: 1 }, pages)).toBe(false);
  });

  it("drops heading-only values even when the heading is present as evidence", async () => {
    const invoke = async () => ({ facts: [{
      field: "竞赛经历",
      value: "竞赛经历",
      evidence: "竞赛经历",
      page: 1,
      confidence: 0.8,
    }] });

    await expect(extractSmartFacts(pages, "jianli.pdf", invoke)).resolves.toEqual([]);
  });

  it.each([
    "专业技能",
    "个人技能",
    "主要荣誉",
    "荣誉奖项",
    "项目经验",
    "专业技能：",
    "荣誉奖项:",
    "技能",
    "技能：",
    "项目经历:",
  ])("drops the common heading-only alias %s", async (value) => {
    const invoke = async () => ({ facts: [{
      field: "技能",
      value,
      evidence: value,
      page: 3,
      confidence: 0.8,
    }] });

    await expect(extractSmartFacts([{ page: 3, text: value }], "jianli.pdf", invoke)).resolves.toEqual([]);
  });

  it("keeps a substantive sentence that starts with a heading alias", async () => {
    const value = "专业技能包括 SystemVerilog 与 UVM";
    const invoke = async () => ({ facts: [{
      field: "技能",
      value,
      evidence: value,
      page: 3,
      confidence: 0.8,
    }] });

    await expect(extractSmartFacts([{ page: 3, text: value }], "jianli.pdf", invoke)).resolves.toHaveLength(1);
  });

  it("rejects locally-owned CET scores even when the model assigns them to 技能", async () => {
    const value = "CET4:514、CET6:470";
    const invoke = async () => ({ facts: [{
      field: "技能",
      value,
      evidence: value,
      page: 1,
      confidence: 0.88,
    }] });

    await expect(extractSmartFacts([{ page: 1, text: `技能=${value}` }], "jianli.pdf", invoke))
      .resolves.toEqual([]);
  });

  it.each([
    "GPA：3.8/4.0",
    "专业排名：3/80",
    "目标方向：集成电路设计",
    "核心课程：数字电路、模拟电路",
  ])("rejects a smart fact consisting solely of local profile data: %s", async (value) => {
    const invoke = async () => ({ facts: [{
      field: "荣誉",
      value,
      evidence: value,
      page: 1,
      confidence: 0.8,
    }] });

    await expect(extractSmartFacts([{ page: 1, text: value }], "jianli.pdf", invoke)).resolves.toEqual([]);
  });

  it("keeps a substantive project sentence that also mentions a locally-owned datum", async () => {
    const value = "在 Atlas 项目中设计流水线，使吞吐率提升 35%，项目期间 GPA 为 3.8";
    const invoke = async () => ({ facts: [{
      field: "项目经历",
      value,
      evidence: value,
      page: 1,
      confidence: 0.86,
    }] });

    await expect(extractSmartFacts([{ page: 1, text: value }], "jianli.pdf", invoke)).resolves.toHaveLength(1);
  });
  it("rejects malformed or disallowed model fields", async () => {
    const invoke = async () => ({ facts: [{
      field: "联系方式",
      value: "13800000000",
      evidence: "13800000000",
      page: 1,
      confidence: 0.8,
    }] });

    await expect(extractSmartFacts(pages, "jianli.pdf", invoke)).rejects.toThrow();
  });

  it("instructs the model to classify semantic facts without requesting contacts", async () => {
    const invoke = vi.fn<SmartExtractionInvoke>(async () => ({ facts: [] }));

    await extractSmartFacts(pages, "jianli.pdf", invoke);

    const options = invoke.mock.calls[0][0];
    expect(options.user).toContain(pages[0].text);
    expect(JSON.stringify(options)).not.toContain("jianli.pdf");
    expect(`${options.system}\n${options.user}`).toContain("阅读顺序");
    expect(`${options.system}\n${options.user}`).toContain("逐字证据");
    expect(`${options.system}\n${options.user}`).toContain("不得提取联系方式");
    expect(`${options.system}\n${options.user}`).toContain("每个彼此独立且有实质描述的经历");
    expect(`${options.system}\n${options.user}`).toContain("不得合并互不相关的经历");
    expect(`${options.system}\n${options.user}`).toContain("不得使用基于名称的白名单");
    expect(`${options.system}\n${options.user}`).not.toMatch(/请(?:提取|返回).{0,8}(?:电话|邮箱|联系方式)/);
  });

  it("requires the exact combined root contract and a material-specific timeout", async () => {
    const invoke = vi.fn<SmartExtractionInvoke>(async () => ({ facts: [] }));

    await extractSmartFacts(pages, "jianli.pdf", invoke);

    const options = invoke.mock.calls[0][0] as Parameters<SmartExtractionInvoke>[0] & { timeoutMs?: number };
    expect(`${options.system}\n${options.user}`).toContain(
      '{"facts":[],"experiences":[]}',
    );
    expect(options.timeoutMs).toBe(120_000);
  });

});
