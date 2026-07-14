import { describe, expect, it } from "vitest";
import { extractLocalFacts, mergeFacts, type EvidenceFactInput } from "./profile-extraction";

describe("local profile extraction", () => {
  it("does not turn neighboring headings or a name into complex facts", () => {
    const facts = extractLocalFacts([{ page: 1, text: [
      "竞赛经历：", "姓名 沈笑", "GPA：4.043/5（均分 90.5399），专业排名 3/42",
      "语 言 ： CET4:514、CET6:470", "科研经历：", "个人技能：", "其它经历：",
    ].join("\n") }], "jianli.pdf");

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "专业排名", value: "3/42" }),
      expect.objectContaining({ field: "英语四级", value: "514" }),
    ]));
    expect(facts.some((fact) => ["科研经历", "竞赛经历", "技能"].includes(fact.field))).toBe(false);
  });

  it("attaches the exact matched line and page to every fact", () => {
    const evidence = "语 言 ： CET4:514、CET6:470";
    const facts = extractLocalFacts([
      { page: 2, text: "个人信息" },
      { page: 7, text: evidence },
    ], "jianli.pdf");

    expect(facts).toHaveLength(2);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "英语四级", value: "514" }),
      expect.objectContaining({ field: "英语六级", value: "470" }),
    ]));
    expect(facts.every((fact) => fact.evidence === evidence && fact.page === 7)).toBe(true);
    expect(facts.every((fact) => fact.source === "jianli.pdf" && fact.extractor === "local")).toBe(true);
  });

  it("merges duplicate field/value pairs but retains different values for one field", () => {
    const fact = (value: string, page: number): EvidenceFactInput => ({
      field: "英语六级",
      value,
      source: "jianli.pdf",
      confidence: 0.78,
      evidence: `CET6:${value}`,
      page,
      extractor: "local",
    });

    expect(mergeFacts([fact("470", 1)], [fact("470", 2), fact("520", 3)])).toEqual([
      fact("470", 1),
      fact("520", 3),
    ]);
  });

  it("rejects headings whose captured value is blank or punctuation only", () => {
    const facts = extractLocalFacts([{ page: 1, text: [
      "目标方向：",
      "核心课程: ：",
      "科研经历：低信噪比同步算法研究",
    ].join("\n") }], "jianli.pdf");

    expect(facts).toEqual([]);
  });
});
