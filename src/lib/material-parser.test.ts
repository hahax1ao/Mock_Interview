import { describe, expect, it } from "vitest";
import { extractFacts } from "./material-parser";

describe("profile extraction", () => {
  it("extracts the confirmed V1 profile categories locally", () => {
    const facts = extractFacts([{
      page: 1,
      text: [
        "专业排名：3/80",
        "平均成绩：88.5",
        "英语六级：520",
        "目标方向：通信与信号处理",
        "核心课程：信号与系统、通信原理",
        "项目经历：LoRa 接收机设计",
        "科研经历：低信噪比同步算法研究",
        "竞赛经历：电子设计竞赛省一等奖",
        "专业技能：MATLAB、Verilog、Python",
      ].join("\n"),
    }], "resume.md", "m1");

    expect(new Set(facts.map((fact) => fact.field))).toEqual(new Set([
      "专业排名", "平均成绩", "英语六级", "目标方向", "核心课程",
      "项目经历", "科研经历", "竞赛经历", "技能",
    ]));
    expect(facts.every((fact) => fact.source === "resume.md" && !fact.confirmed)).toBe(true);
  });
});
