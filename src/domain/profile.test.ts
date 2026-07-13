import { describe, expect, it } from "vitest";
import { confirmProfileFacts, findFactConflicts } from "./profile";

describe("profile facts", () => {
  it("marks only explicitly selected facts as confirmed", () => {
    const facts = [
      { id: "a", field: "英语六级", value: "520", source: "resume.pdf:1", confidence: 0.95, confirmed: false },
      { id: "b", field: "均分", value: "88", source: "transcript.png:1", confidence: 0.7, confirmed: false },
    ];

    expect(confirmProfileFacts(facts, ["a"]).map((fact) => fact.confirmed)).toEqual([true, false]);
  });

  it("finds conflicting values for the same field", () => {
    const conflicts = findFactConflicts([
      { id: "a", field: "专业排名", value: "3/80", source: "resume.pdf:1", confidence: 0.9, confirmed: false },
      { id: "b", field: "专业排名", value: "4/80", source: "form", confidence: 1, confirmed: false },
    ]);

    expect(conflicts).toEqual([{ field: "专业排名", factIds: ["a", "b"] }]);
  });
});
