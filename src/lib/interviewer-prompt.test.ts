import { describe, expect, it } from "vitest";
import { interviewerPrompt } from "./interviewer-prompt";

describe("interviewerPrompt", () => {
  it("forbids technical English questions", () => {
    expect(interviewerPrompt).toContain("【英语老师】只进行非技术性的英语交流");
    expect(interviewerPrompt).toContain("不得询问专业课、论文、具体项目、竞赛内容或技术细节");
    expect(interviewerPrompt).not.toContain("项目问答");
  });
});
