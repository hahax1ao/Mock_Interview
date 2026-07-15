import { describe, expect, it, vi } from "vitest";
import {
  ingestMaterial,
  reconcileExperienceDrafts,
  retrySmartExtraction,
  type IngestionDependencies,
  type RetrySmartExtractionDependencies,
} from "./material-ingestion";
import { sha256 } from "./material-dedup";
import type { EvidenceFactInput } from "./profile-extraction";
import type { ExtractedExperience } from "./material-smart-extraction";
import type { ProfileExperience } from "../domain/experiences";

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
const experience = (title: string, type: ExtractedExperience["type"] = "project"): ExtractedExperience => ({
  type,
  title,
  background: `${title} background`,
  responsibilities: `${title} responsibilities`,
  methods: `${title} methods`,
  results: `${title} results`,
  awardRole: "",
  source: "resume.txt",
  page: 1,
  evidence: { title, background: `${title} background` },
  confidence: 0.8,
});

function ingestionDependencies(
  overrides: Partial<IngestionDependencies> = {},
): IngestionDependencies {
  return {
    listMaterials: vi.fn(async () => []),
    updateMaterialHash: vi.fn(async () => undefined),
    reserveContentHash: vi.fn(async () => ({ kind: "reserved" as const })),
    releaseContentHash: vi.fn(async () => undefined),
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
    extractSmartProfile: vi.fn(async () => ({
      facts: [fact("项目经历", "Project Atlas", "qwen")],
      experiences: [experience("Atlas"), experience("Beacon"), experience("Compass")],
    })),
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
    const extractSmartProfile = vi.fn(async () => ({ facts: [], experiences: [] }));
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
      extractSmartProfile,
      writeUpload,
    });

    const result = await ingestMaterial(input, deps);

    expect(result).toEqual({
      kind: "duplicate",
      material: { id: "material-old", name: "old-name.txt", createdAt: 100 },
    });
    expect(parseMaterial).not.toHaveBeenCalled();
    expect(extractSmartProfile).not.toHaveBeenCalled();
    expect(writeUpload).not.toHaveBeenCalled();
  });

  it("atomically reserves concurrent identical uploads before parsing or calling the model", async () => {
    const reservations = new Map<string, { id: string; name: string; createdAt: number; state: "pending" | "committed" }>();
    let nextId = 0;
    const deps = ingestionDependencies({
      reserveContentHash: vi.fn(async (contentHash, owner) => {
        const duplicate = reservations.get(contentHash);
        if (duplicate) return { kind: "duplicate" as const, material: duplicate };
        reservations.set(contentHash, { id: owner.materialId, name: owner.name, createdAt: owner.createdAt, state: "pending" });
        return { kind: "reserved" as const };
      }),
      releaseContentHash: vi.fn(async (contentHash, materialId) => {
        if (reservations.get(contentHash)?.id === materialId) reservations.delete(contentHash);
      }),
      createId: () => `id-${++nextId}`,
    });

    const results = await Promise.all([ingestMaterial(input, deps), ingestMaterial(input, deps)]);

    expect(results.map((result) => result.kind)).toContain("created");
    expect(results.map((result) => result.kind)).toSatisfy((kinds: string[]) => kinds.includes("in_progress") || kinds.includes("duplicate"));
    expect(deps.parseMaterial).toHaveBeenCalledOnce();
    expect(deps.extractSmartProfile).toHaveBeenCalledOnce();
    expect(deps.persistCreated).toHaveBeenCalledOnce();
  });

  it("lets a future retry proceed after the winning ingestion fails and releases its reservation", async () => {
    let owner: string | undefined;
    let attempts = 0;
    const deps = ingestionDependencies({
      reserveContentHash: vi.fn(async (_hash, candidate) => {
        if (owner) return { kind: "in_progress" as const, owner: { id: owner, name: input.name, createdAt: 200 } };
        owner = candidate.materialId;
        return { kind: "reserved" as const };
      }),
      releaseContentHash: vi.fn(async (_hash, materialId) => {
        if (owner === materialId) owner = undefined;
      }),
      parseMaterial: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("parser crashed");
        return [page];
      }),
    });
    await expect(ingestMaterial(input, deps)).rejects.toThrow("parser crashed");
    await expect(ingestMaterial(input, deps)).resolves.toMatchObject({ kind: "created" });
    expect(deps.parseMaterial).toHaveBeenCalledTimes(2);
  });

  it("preserves the ingestion error and surfaces a reservation release failure", async () => {
    const original = new Error("database unavailable");
    const release = new Error("reservation release unavailable");
    const deps = ingestionDependencies({
      persistCreated: vi.fn(async () => { throw original; }),
      releaseContentHash: vi.fn(async () => { throw release; }),
    });
    const error = await ingestMaterial(input, deps).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(expect.arrayContaining([original, release]));
  });

  it("returns created only after fenced persistence succeeds", async () => {
    const persistCreated = vi.fn(async () => { throw new Error("reservation ownership lost"); });
    const deps = ingestionDependencies({ persistCreated });

    await expect(ingestMaterial(input, deps)).rejects.toThrow("reservation ownership lost");
    expect(persistCreated).toHaveBeenCalledOnce();
  });

  it("releases only its owned hash reservation when ingestion fails", async () => {
    const releaseContentHash = vi.fn(async () => undefined);
    const deps = ingestionDependencies({
      persistCreated: vi.fn(async () => { throw new Error("database unavailable"); }),
      releaseContentHash,
    });

    await expect(ingestMaterial(input, deps)).rejects.toThrow("database unavailable");

    expect(releaseContentHash).toHaveBeenCalledWith(sha256(input.buffer), "material-new");
  });

  it("chooses the deterministic oldest legacy duplicate without creating a unique hash index", async () => {
    const contentHash = sha256(input.buffer);
    const reserveContentHash = vi.fn();
    const deps = ingestionDependencies({
      listMaterials: vi.fn(async () => [
        { id: "z-later", name: "later.txt", filePath: "later", contentHash, createdAt: 200 },
        { id: "b-old", name: "old-b.txt", filePath: "old-b", contentHash, createdAt: 100 },
        { id: "a-old", name: "old-a.txt", filePath: "old-a", contentHash, createdAt: 100 },
      ]),
      reserveContentHash,
    });

    await expect(ingestMaterial(input, deps)).resolves.toEqual({
      kind: "duplicate",
      material: { id: "a-old", name: "old-a.txt", createdAt: 100 },
    });
    expect(reserveContentHash).not.toHaveBeenCalled();
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
    expect(deps.extractSmartProfile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "created", parseStatus: "complete", localFacts: 0, smartFacts: 0 });
  });

  it("keeps the local upload as basic_only when Qwen rejects", async () => {
    const deps = ingestionDependencies({
      extractSmartProfile: vi.fn(async () => { throw new Error("model unavailable"); }),
    });

    const result = await ingestMaterial(input, deps);

    expect(result).toMatchObject({ kind: "created", parseStatus: "basic_only", localFacts: 1, smartFacts: 0, experiences: 0 });
    expect(deps.persistCreated).toHaveBeenCalledWith(expect.objectContaining({
      material: expect.objectContaining({ parseStatus: "basic_only" }),
      facts: [expect.objectContaining({ extractor: "local" })],
      experiences: [],
    }));
  });

  it("merges local and smart facts and marks successful extraction complete", async () => {
    const deps = ingestionDependencies();

    const result = await ingestMaterial(input, deps);

    expect(result).toMatchObject({
      kind: "created", parseStatus: "complete", localFacts: 1, smartFacts: 1, experiences: 3,
    });
    expect(deps.persistCreated).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.arrayContaining([
      expect.objectContaining({ extractor: "local" }),
      expect.objectContaining({ extractor: "qwen" }),
    ]), experiences: expect.arrayContaining([
      expect.objectContaining({ materialId: "material-new", title: "Atlas", status: "draft" }),
    ]) }));
    const persisted = vi.mocked(deps.persistCreated).mock.calls[0][0];
    expect(persisted.experiences).toHaveLength(3);
  });
});

describe("experience draft reconciliation", () => {
  const stored = (overrides: Partial<ProfileExperience>): ProfileExperience => ({
    ...experience("Atlas"),
    id: "draft-atlas",
    materialId: "material-1",
    status: "draft",
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  });

  it("updates matching drafts, inserts new drafts, and preserves confirmed and stale cards", () => {
    const existing = [
      stored({ title: " Atlas ", methods: "old", createdAt: 10 }),
      stored({ id: "confirmed-beacon", title: "BEACON", status: "confirmed", methods: "user edit", createdAt: 20 }),
      stored({ id: "stale", title: "Stale", methods: "keep me", createdAt: 30 }),
    ];
    let id = 0;
    const result = reconcileExperienceDrafts(existing, [
      { ...experience("Ａｔｌａｓ"), materialId: "material-1", methods: "new model value" },
      { ...experience(" beacon "), materialId: "material-1", methods: "must not overwrite" },
      { ...experience("Compass"), materialId: "material-1" },
    ], () => `new-${++id}`, () => 100);
    expect(result).toEqual([
      expect.objectContaining({ id: "draft-atlas", title: "Ａｔｌａｓ", methods: "new model value", createdAt: 10, updatedAt: 100 }),
      existing[1],
      existing[2],
      expect.objectContaining({ id: "new-1", title: "Compass", status: "draft", createdAt: 100, updatedAt: 100 }),
    ]);
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
      experiences: [],
    })),
    extractSmartProfile: vi.fn(async () => ({
      facts: [
        fact(" 技能 ", "typescript", "qwen"),
        fact("项目经历", "Atlas", "qwen"),
      ],
      experiences: [experience("Atlas")],
    })),
    persistRetry: vi.fn(async () => undefined),
    createId: () => "fact-new",
    now: () => 300,
    ...overrides,
  };
}

describe("smart extraction retry", () => {
  it("groups stored chunks by page and inserts only new normalized fact keys", async () => {
    const deps = retryDependencies();

    const result = await retrySmartExtraction("material-1", deps);

    expect(deps.extractSmartProfile).toHaveBeenCalledWith([
      { page: 1, text: "one\n\ntwo" },
      { page: 2, text: "three" },
    ], "resume.txt");
    expect(result).toEqual({ smartFacts: 1, experiences: 1 });
    expect(deps.persistRetry).toHaveBeenCalledWith({
      materialId: "material-1",
      parseStatus: "complete",
      facts: [expect.objectContaining({ field: "项目经历", value: "Atlas", extractor: "qwen" })],
      experienceUpdates: [],
      experienceInserts: [expect.objectContaining({ title: "Atlas", status: "draft" })],
    });
  });

  it("persists only matching draft updates and new draft inserts while protecting confirmed cards", async () => {
    const draft: ProfileExperience = {
      ...experience("Atlas"), id: "draft-atlas", materialId: "material-1", status: "draft", createdAt: 10, updatedAt: 10,
    };
    const confirmed: ProfileExperience = {
      ...experience("Beacon"), id: "confirmed-beacon", materialId: "material-1", status: "confirmed",
      methods: "user edit", createdAt: 20, updatedAt: 20,
    };
    let id = 0;
    const deps = retryDependencies({
      loadMaterial: vi.fn(async () => ({
        id: "material-1", name: "resume.txt", category: "personal", parseStatus: "complete",
        chunks: [{ page: 1, start: 0, text: "content" }], facts: [], experiences: [draft, confirmed],
      })),
      extractSmartProfile: vi.fn(async () => ({ facts: [], experiences: [
        { ...experience(" Atlas "), methods: "refreshed" },
        { ...experience("BEACON"), methods: "model overwrite" },
        experience("Compass"),
      ] })),
      createId: () => `new-${++id}`,
    });

    await expect(retrySmartExtraction("material-1", deps)).resolves.toEqual({ smartFacts: 0, experiences: 2 });
    expect(deps.persistRetry).toHaveBeenCalledWith(expect.objectContaining({
      experienceUpdates: [expect.objectContaining({ id: "draft-atlas", methods: "refreshed", createdAt: 10 })],
      experienceInserts: [expect.objectContaining({ id: "new-1", title: "Compass", status: "draft" })],
    }));
    const persisted = vi.mocked(deps.persistRetry).mock.calls[0][0];
    expect([...persisted.experienceUpdates, ...persisted.experienceInserts]).not.toContainEqual(
      expect.objectContaining({ id: "confirmed-beacon" }),
    );
  });
  it("does not mutate facts or status when the model call fails", async () => {
    const persistRetry = vi.fn(async () => undefined);
    const deps = retryDependencies({
      extractSmartProfile: vi.fn(async () => { throw new Error("Qwen timeout"); }),
      persistRetry,
    });

    await expect(retrySmartExtraction("material-1", deps)).rejects.toThrow("Qwen timeout");
    expect(persistRetry).not.toHaveBeenCalled();
  });
});
