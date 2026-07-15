import { describe, expect, it } from "vitest";
import { planLegacyDraftKeys } from "./experience-normalization";

describe("legacy experience normalization", () => {
  it("keeps the newest duplicate draft canonical and suffixes older rows without deleting them", () => {
    const rows = [
      { id: "old", materialId: "m1", type: "project", title: " Atlas ", status: "draft", updatedAt: 10 },
      { id: "new", materialId: "m1", type: "project", title: "Ａｔｌａｓ", status: "draft", updatedAt: 20 },
      { id: "other-type", materialId: "m1", type: "research", title: "Atlas", status: "draft", updatedAt: 5 },
      { id: "other-material", materialId: "m2", type: "project", title: "Atlas", status: "draft", updatedAt: 5 },
      { id: "confirmed", materialId: "m1", type: "project", title: "Atlas", status: "confirmed", updatedAt: 30 },
    ] as const;

    expect(planLegacyDraftKeys(rows)).toEqual(new Map([
      ["new", "atlas"],
      ["old", "atlas#legacy:old"],
      ["other-type", "atlas"],
      ["other-material", "atlas"],
    ]));
  });
});
