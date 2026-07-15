import { describe, expect, it, vi } from "vitest";
import { createPatchExperienceHandler, type PatchExperienceRouteDependencies } from "./route";

const original = {
  id: "experience-1",
  materialId: "material-1",
  type: "project" as const,
  title: "原始标题",
  background: "背景",
  responsibilities: "职责",
  methods: "方法",
  results: "结果",
  awardRole: "",
  source: "resume.pdf",
  page: 3,
  evidence: { title: "原始证据", methods: "证据方法" },
  confidence: 0.91,
  status: "confirmed" as const,
  createdAt: 100,
  updatedAt: 100,
};

function dependencies(overrides: Partial<PatchExperienceRouteDependencies> = {}): PatchExperienceRouteDependencies {
  return {
    initDatabase: vi.fn(async () => undefined),
    now: () => 200,
    updateExperience: vi.fn(async (_id, editable, status, updatedAt) => ({
      ...original,
      ...editable,
      status,
      updatedAt,
    })),
    ...overrides,
  };
}

function call(handler: ReturnType<typeof createPatchExperienceHandler>, body: unknown, id = original.id) {
  return handler(new Request(`http://localhost/api/experiences/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

const editable = {
  type: "research",
  title: "用户修正标题",
  background: "修正背景",
  responsibilities: "修正职责",
  methods: "修正方法",
  results: "修正结果",
  awardRole: "修正角色",
};

describe("PATCH experience route", () => {
  it("updates editable fields and explicitly returns a confirmed card to draft", async () => {
    const deps = dependencies();
    const response = await call(createPatchExperienceHandler(deps), {
      ...editable,
      evidence: { title: "伪造证据" },
      source: "browser.txt",
      page: 99,
      confidence: 0,
      createdAt: 999,
      status: "confirmed",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      experience: expect.objectContaining({
        title: "用户修正标题",
        status: "draft",
        evidence: original.evidence,
        source: original.source,
        page: original.page,
        confidence: original.confidence,
        createdAt: original.createdAt,
      }),
    });
    expect(deps.updateExperience).toHaveBeenCalledWith(original.id, editable, "draft", 200);
  });

  it("returns 404 when the card does not exist", async () => {
    const handler = createPatchExperienceHandler(dependencies({
      updateExperience: vi.fn(async () => undefined),
    }));

    const response = await call(handler, editable, "missing");

    expect(response.status).toBe(404);
  });
});
