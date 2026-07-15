import { describe, expect, it, vi } from "vitest";
import { createConfirmExperienceHandler, type ConfirmExperienceRouteDependencies } from "./route";

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
  evidence: { title: "原始证据", results: "证据结果" },
  confidence: 0.91,
  status: "draft" as const,
  createdAt: 100,
  updatedAt: 100,
};

function dependencies(overrides: Partial<ConfirmExperienceRouteDependencies> = {}): ConfirmExperienceRouteDependencies {
  return {
    initDatabase: vi.fn(async () => undefined),
    now: () => 300,
    confirmExperience: vi.fn(async (_id, editable, status, updatedAt) => ({
      ...original,
      ...editable,
      status,
      updatedAt,
    })),
    ...overrides,
  };
}

function call(handler: ReturnType<typeof createConfirmExperienceHandler>, body: unknown, id = original.id) {
  return handler(new Request(`http://localhost/api/experiences/${id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

const editable = {
  type: "competition",
  title: "用户确认标题",
  background: "确认背景",
  responsibilities: "确认职责",
  methods: "确认方法",
  results: "确认结果",
  awardRole: "队长",
};

describe("POST experience confirmation route", () => {
  it("atomically saves the whole editable card as confirmed", async () => {
    const deps = dependencies();
    const response = await call(createConfirmExperienceHandler(deps), {
      ...editable,
      evidence: { title: "伪造证据" },
      source: "browser.txt",
      page: 99,
      confidence: 0,
      createdAt: 999,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).experience).toEqual(expect.objectContaining({
      ...editable,
      status: "confirmed",
      evidence: original.evidence,
      source: original.source,
      page: original.page,
      confidence: original.confidence,
      createdAt: original.createdAt,
    }));
    expect(deps.confirmExperience).toHaveBeenCalledTimes(1);
    expect(deps.confirmExperience).toHaveBeenCalledWith(original.id, editable, "confirmed", 300);
  });

  it("returns 404 when the card does not exist", async () => {
    const response = await call(createConfirmExperienceHandler(dependencies({
      confirmExperience: vi.fn(async () => undefined),
    })), editable, "missing");

    expect(response.status).toBe(404);
  });

  it("returns 400 without writing when every detail field is empty", async () => {
    const deps = dependencies();
    const response = await call(createConfirmExperienceHandler(deps), {
      type: "project",
      title: "只有标题",
      background: "",
      responsibilities: "",
      methods: "",
      results: "",
      awardRole: "",
    });

    expect(response.status).toBe(400);
    expect(deps.confirmExperience).not.toHaveBeenCalled();
  });
});
