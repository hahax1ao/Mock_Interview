import { describe, expect, it } from "vitest";
import { materialConflictResponse, materialCreatedResponse } from "./route";

describe("POST material route conflicts", () => {
  it("maps an active reservation to an explicit 409 with owner metadata", async () => {
    const owner = { id: "owner", name: "resume.pdf", createdAt: 10 };
    const response = materialConflictResponse({ kind: "in_progress", owner });

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "相同材料正在处理中",
      inProgressOwner: owner,
    });
  });

  it("returns the persisted experience count for a created material", async () => {
    const response = materialCreatedResponse({
      kind: "created",
      materialId: "material-1",
      pages: 2,
      chunks: 4,
      parseStatus: "complete",
      localFacts: 1,
      smartFacts: 2,
      experiences: 3,
    }, { name: "resume.pdf", category: "personal" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(expect.objectContaining({ experiences: 3 }));
  });
  it("does not treat a created result as a conflict", () => {
    expect(materialConflictResponse({ kind: "created" })).toBeNull();
  });
});
