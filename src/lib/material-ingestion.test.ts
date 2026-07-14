import { describe, expect, it, vi } from "vitest";
import {
  ingestMaterial,
  retrySmartExtraction,
  type IngestionDependencies,
  type RetrySmartExtractionDependencies,
} from "./material-ingestion";
import type { EvidenceFactInput } from "./profile-extraction";

const page = { page: 1, text: "GPA: 3.8\nProject Atlas" };
const fact = (field: string, value: string, extractor = "local"): EvidenceFactInput => ({
  field,
  value,
  source: "resume.txt",
  confidence: 0.8,
  evidence: value,
  page: 1,
  extractor,
});

function ingestionDependencies(
  overrides: Partial<IngestionDependencies> = {},
): IngestionDependencies {
  return {
    listMaterials: vi.fn(async () => []),
    updateMaterialHash: vi.fn(async () => undefined),
    writeUpload: vi.fn(async ({ materialId, name }) => `uploads/${materialId}/${name}`),
    removeUpload: vi.fn(async () => undefined),
    parseMaterial: vi.fn(async () => [page]),
    chunkMaterial: vi.fn(({ materialId, source, pages }) => pages.map((item: typeof page, index: number) => ({
      id: `${materialId}:${index}`,
      materialId,
      source,
      page: item.page,
      text: item.text,
      position: { start: 0, end: item.text.length },
    }))),
    extractLocalFacts: vi.fn(() => [fact("GPA", "3.8")]),
    extractSmartFacts: vi.fn(async () => [fact("项目经历", "Project Atlas", "qwen")]),
    persistCreated: vi.fn(async () => undefined),
    createId: () => "material-new",
    now: () => 200,
    ...overrides,
  };
}

const input = {
  name: "resume.txt",
  mimeType: "text/plain",
  category: "personal" as const,
  buffer: Buffer.from("new bytes"),
};

describe("material ingestion", () => {
  it("returns an exact duplicate before parsing, writing, or calling Qwen", async () => {
    const parseMaterial = vi.fn(async () => [page]);
    const extractSmartFacts = vi.fn(async () => []);
    const writeUpload = vi.fn(async () => "unexpected");
    const deps = ingestionDependencies({
      listMaterials: vi.fn(async () => [{
        id: "material-old",
        name: "old-name.txt",
        filePath: "old.txt",
        contentHash: "11e2defd59f47c7f2aac84d6a5d6747e98e785afffb72c8bb7b05ec74e1d663c",
        createdAt: 100,
      }]),
      parseMaterial,
      extractSmartFacts,
      writeUpload,
    });

    const result = await ingestMaterial(input, deps);

    expect(result).toEqual({
      kind: "duplicate",
      material: { id: "material-old", name: "old-name.txt", createdAt: 100 },
    });
    expect(parseMaterial).not.toHaveBeenCalled();
    expect(extractSmartFacts).not.toHaveBeenCalled();
    expect(writeUpload).not.toHaveBeenCalled();
  });

  it("accepts the same filename when the bytes differ", async () => {
    const deps = ingestionDependencies({
      listMaterials: vi.fn(async () => [{
        id: "material-old",
        name: input.name,
        filePath: "old.txt",
        contentHash: "different-hash",
        createdAt: 100,
      }]),
    });

    await expect(ingestMaterial(input, deps)).resolves.toMatchObject({
      kind: "created",
      materialId: "material-new",
    });
    expect(deps.parseMaterial).toHaveBeenCalledOnce();
  });

  it("skips all profile extraction for non-personal material", async () => {
    const deps = ingestionDependencies();

    const result = await ingestMaterial({ ...input, category: "reference" }, deps);

    expect(deps.extractLocalFacts).not.toHaveBeenCalled();
    expect(deps.extractSmartFacts).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "created", parseStatus: "complete", localFacts: 0, smartFacts: 0 });
  });

  it("keeps the local upload as basic_only when Qwen rejects", async () => {
    const deps = ingestionDependencies({
      extractSmartFacts: vi.fn(async () => { throw new Error("model unavailable"); }),
    });

    const result = await ingestMaterial(input, deps);

    expect(result).toMatchObject({ kind: "created", parseStatus: "basic_only", localFacts: 1, smartFacts: 0 });
    expect(deps.persistCreated).toHaveBeenCalledWith(expect.objectContaining({
      material: expect.objectContaining({ parseStatus: "basic_only" }),
      facts: [expect.objectContaining({ extractor: "local" })],
    }));
  });

  it("merges local and smart facts and marks successful extraction complete", async () => {
    const deps = ingestionDependencies();

    const result = await ingestMaterial(input, deps);

    expect(result).toMatchObject({ kind: "created", parseStatus: "complete", localFacts: 1, smartFacts: 1 });
    expect(deps.persistCreated).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.arrayContaining([
      expect.objectContaining({ extractor: "local" }),
      expect.objectContaining({ extractor: "qwen" }),
    ]) }));
  });
});

function retryDependencies(
  overrides: Partial<RetrySmartExtractionDependencies> = {},
): RetrySmartExtractionDependencies {
  return {
    loadMaterial: vi.fn(async () => ({
      id: "material-1",
      name: "resume.txt",
      category: "personal",
      parseStatus: "basic_only",
      chunks: [
        { page: 2, start: 0, text: "three" },
        { page: 1, start: 10, text: "two" },
        { page: 1, start: 0, text: "one" },
      ],
      facts: [fact("技能", "TypeScript")],
    })),
    extractSmartFacts: vi.fn(async () => [
      fact(" 技能 ", "typescript", "qwen"),
      fact("项目经历", "Atlas", "qwen"),
    ]),
    persistRetry: vi.fn(async () => undefined),
    createId: () => "fact-new",
    ...overrides,
  };
}

describe("smart extraction retry", () => {
  it("groups stored chunks by page and inserts only new normalized fact keys", async () => {
    const deps = retryDependencies();

    const result = await retrySmartExtraction("material-1", deps);

    expect(deps.extractSmartFacts).toHaveBeenCalledWith([
      { page: 1, text: "one\n\ntwo" },
      { page: 2, text: "three" },
    ], "resume.txt");
    expect(result).toEqual({ smartFacts: 1 });
    expect(deps.persistRetry).toHaveBeenCalledWith({
      materialId: "material-1",
      parseStatus: "complete",
      facts: [expect.objectContaining({ field: "项目经历", value: "Atlas", extractor: "qwen" })],
    });
  });

  it("does not mutate facts or status when the model call fails", async () => {
    const persistRetry = vi.fn(async () => undefined);
    const deps = retryDependencies({
      extractSmartFacts: vi.fn(async () => { throw new Error("Qwen timeout"); }),
      persistRetry,
    });

    await expect(retrySmartExtraction("material-1", deps)).rejects.toThrow("Qwen timeout");
    expect(persistRetry).not.toHaveBeenCalled();
  });
});
