import { describe, expect, it, vi } from "vitest";
import { createDeleteMaterialHandler, type DeleteMaterialRouteDependencies } from "./route";

const material = {
  id: "material-1",
  name: "resume.pdf",
  filePath: "C:/safe/uploads/material-1/resume.pdf",
  contentHash: "hash-1",
};

function dependencies(overrides: Partial<DeleteMaterialRouteDependencies> = {}): DeleteMaterialRouteDependencies {
  return {
    initDatabase: vi.fn(async () => undefined),
    findMaterial: vi.fn(async () => material),
    storageRoot: () => "C:/safe",
    deleteSafely: vi.fn(async (_input, deleteRecord) => {
      await deleteRecord();
      return { cleanupPending: false };
    }),
    deleteRecord: vi.fn(async () => undefined),
    ...overrides,
  };
}

const call = (handler: ReturnType<typeof createDeleteMaterialHandler>) => handler(
  new Request("http://localhost/api/materials/material-1", { method: "DELETE" }),
  { params: Promise.resolve({ id: material.id }) },
);

describe("DELETE material route error contract", () => {
  it("maps an invalid file path to sanitized JSON 400", async () => {
    const handler = createDeleteMaterialHandler(dependencies({
      deleteSafely: vi.fn(async () => { throw new Error("Invalid material path: C:/secret.txt"); }),
    }));
    const response = await call(handler);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "材料路径无效",
      errorClass: "InvalidMaterialPath",
      message: "材料文件路径不合法",
    });
  });

  it("maps database and rollback failures to sanitized JSON 500", async () => {
    const handler = createDeleteMaterialHandler(dependencies({
      deleteSafely: vi.fn(async (_input, deleteRecord) => deleteRecord()),
      deleteRecord: vi.fn(async () => { throw new TypeError("database DSN secret"); }),
    }));
    const response = await call(handler);
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "材料删除失败",
      errorClass: "TypeError",
      message: "数据库或文件操作失败",
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("keeps cleanupPending as a successful JSON response", async () => {
    const handler = createDeleteMaterialHandler(dependencies({
      deleteSafely: vi.fn(async (_input, deleteRecord) => {
        await deleteRecord();
        return { cleanupPending: true };
      }),
    }));
    const response = await call(handler);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedId: material.id, cleanupPending: true });
  });
});