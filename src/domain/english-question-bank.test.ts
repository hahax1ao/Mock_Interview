import { describe, expect, it } from "vitest";
import {
  englishQuestionBank,
  isForbiddenEnglishQuestion,
  isValidEnglishQuestion,
  selectEnglishQuestion,
} from "./english-question-bank";

describe("english question bank", () => {
  it("contains no technical, course, paper, project, or competition prompts", () => {
    const forbidden = [
      "Please introduce your major.",
      "Could you please introduce your favorite subject?",
      "Your professional skills?",
      "Please introduce your paper.",
      "Introduce your research and competition experience.",
    ];
    expect(englishQuestionBank.map((item) => item.text)).not.toEqual(
      expect.arrayContaining(forbidden),
    );
    expect(englishQuestionBank.every((item) => !isForbiddenEnglishQuestion(item.text))).toBe(true);
  });

  it("rotates categories and never repeats a used question id", () => {
    const first = selectEnglishQuestion([], []);
    const second = selectEnglishQuestion([first.id], [first.category]);
    expect(second.id).not.toBe(first.id);
    expect(second.category).not.toBe(first.category);
  });

  it.each([
    "Please explain the algorithm in your project.",
    "Introduce your favorite professional course.",
    "Tell me about your paper.",
    "Describe the technical details of your competition entry.",
  ])("rejects forbidden English prompt: %s", (text) => {
    expect(isForbiddenEnglishQuestion(text)).toBe(true);
  });

  it("accepts an allowed prompt with exactly one question mark", () => {
    expect(isValidEnglishQuestion("How do you face pressure?")).toBe(true);
  });

  it.each([
    "How do you face pressure",
    "How do you face pressure??",
    "你如何面对压力？？",
  ])("rejects a prompt without exactly one question mark: %s", (text) => {
    expect(isValidEnglishQuestion(text)).toBe(false);
  });
});
