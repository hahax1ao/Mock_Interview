import { describe, expect, it, vi } from "vitest";
import {
  extractSmartFacts,
  validateSmartEvidence,
  type SmartExtractionInvoke,
} from "./material-smart-extraction";

const pages = [
  { page: 1, text: "竞赛经历\n2025年 全国大学生嵌入式芯片与系统设计竞赛 FPGA赛道 全国二等奖" },
  { page: 2, text: "技能\n熟练使用 SystemVerilog 与 UVM" },
];

describe("smart material extraction", () => {
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
    expect(`${options.system}\n${options.user}`).not.toMatch(/请(?:提取|返回).{0,8}(?:电话|邮箱|联系方式)/);
  });
});
