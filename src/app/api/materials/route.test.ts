import { describe, expect, it } from "vitest";
import { materialConflictResponse } from "./route";

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

  it("does not treat a created result as a conflict", () => {
    expect(materialConflictResponse({ kind: "created" })).toBeNull();
  });
});
