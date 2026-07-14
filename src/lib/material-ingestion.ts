import type { MaterialChunk } from "../domain/materials";
import { backfillMaterialHashes, sha256, type MaterialHashRow } from "./material-dedup";
import type { ParsedPage } from "./material-parser";
import { mergeFacts, type EvidenceFactInput } from "./profile-extraction";

export type MaterialCategory = "personal" | "target" | "reference";
export type ParseStatus = "complete" | "basic_only";

interface ExistingMaterial extends MaterialHashRow {
  name: string;
  createdAt: number;
}

export interface StoredFact extends EvidenceFactInput {
  id: string;
  materialId: string;
  confirmed: boolean;
}

interface StoredChunk {
  id: string;
  materialId: string;
  source: string;
  page: number;
  text: string;
  start: number;
  end: number;
}

export interface PersistCreatedInput {
  material: {
    id: string;
    name: string;
    category: MaterialCategory;
    mimeType: string;
    filePath: string;
    status: "ready";
    contentHash: string;
    parseStatus: ParseStatus;
    createdAt: number;
  };
  chunks: StoredChunk[];
  facts: StoredFact[];
}

export interface IngestionDependencies {
  listMaterials(): Promise<ExistingMaterial[]>;
  updateMaterialHash(id: string, hash: string): Promise<void>;
  reserveContentHash(hash: string, owner: { materialId: string; name: string; createdAt: number }): Promise<
    | { kind: "reserved" }
    | { kind: "duplicate"; material: { id: string; name: string; createdAt: number } }
  | { kind: "in_progress"; owner: { id: string; name: string; createdAt: number } }
  >;
  releaseContentHash(hash: string, materialId: string): Promise<void>;
  writeUpload(input: { materialId: string; name: string; buffer: Buffer }): Promise<string>;
  removeUpload(materialId: string): Promise<void>;
  parseMaterial(name: string, mimeType: string, buffer: Buffer): Promise<ParsedPage[]>;
  chunkMaterial(input: { materialId: string; source: string; pages: ParsedPage[] }): MaterialChunk[];
  extractLocalFacts(pages: ParsedPage[], source: string): EvidenceFactInput[];
  extractSmartFacts(pages: ParsedPage[], source: string): Promise<EvidenceFactInput[]>;
  persistCreated(input: PersistCreatedInput): Promise<void>;
  createId(): string;
  now(): number;
}

export interface IngestionInput {
  name: string;
  mimeType: string;
  category: MaterialCategory;
  buffer: Buffer;
}

export type IngestionResult =
  | { kind: "duplicate"; material: { id: string; name: string; createdAt: number } }
  | { kind: "in_progress"; owner: { id: string; name: string; createdAt: number } }
  | {
      kind: "created";
      materialId: string;
      pages: number;
      chunks: number;
      parseStatus: ParseStatus;
      localFacts: number;
      smartFacts: number;
    };

export async function ingestMaterial(
  input: IngestionInput,
  dependencies: IngestionDependencies,
): Promise<IngestionResult> {
  const contentHash = sha256(input.buffer);
  const existing = await backfillMaterialHashes(
    await dependencies.listMaterials(),
    dependencies.updateMaterialHash,
  ) as ExistingMaterial[];
  const duplicate = existing
    .filter((material) => material.contentHash === contentHash)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
  if (duplicate) {
    return {
      kind: "duplicate",
      material: { id: duplicate.id, name: duplicate.name, createdAt: duplicate.createdAt },
    };
  }

  const materialId = dependencies.createId();
  const createdAt = dependencies.now();
  const reservation = await dependencies.reserveContentHash(contentHash, {
    materialId,
    name: input.name,
    createdAt,
  });
  if (reservation.kind !== "reserved") return reservation;

  try {
    const filePath = await dependencies.writeUpload({ materialId, name: input.name, buffer: input.buffer });
    const pages = await dependencies.parseMaterial(input.name, input.mimeType, input.buffer);
    const chunks = dependencies.chunkMaterial({ materialId, source: input.name, pages });
    let localFacts: EvidenceFactInput[] = [];
    let smartFacts: EvidenceFactInput[] = [];
    let parseStatus: ParseStatus = "complete";

    if (input.category === "personal") {
      localFacts = dependencies.extractLocalFacts(pages, input.name);
      try {
        smartFacts = await dependencies.extractSmartFacts(pages, input.name);
      } catch {
        parseStatus = "basic_only";
      }
    }

    const storedFacts = mergeFacts(localFacts, smartFacts).map((fact) => ({
      ...fact,
      id: dependencies.createId(),
      materialId,
      confirmed: false,
    }));
    await dependencies.persistCreated({
      material: {
        id: materialId,
        name: input.name,
        category: input.category,
        mimeType: input.mimeType || "application/octet-stream",
        filePath,
        status: "ready",
        contentHash,
        parseStatus,
        createdAt,
      },
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        materialId: chunk.materialId,
        source: chunk.source,
        page: chunk.page,
        text: chunk.text,
        start: chunk.position?.start ?? 0,
        end: chunk.position?.end ?? chunk.text.length,
      })),
      facts: storedFacts,
    });

    return {
      kind: "created",
      materialId,
      pages: pages.length,
      chunks: chunks.length,
      parseStatus,
      localFacts: storedFacts.filter((fact) => fact.extractor === "local").length,
      smartFacts: storedFacts.filter((fact) => fact.extractor === "qwen").length,
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      dependencies.removeUpload(materialId),
      dependencies.releaseContentHash(contentHash, materialId),
    ]);
    const cleanupErrors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], "Material ingestion failed and cleanup was incomplete");
    }
    throw error;
  }
}

interface RetryMaterial {
  id: string;
  name: string;
  category: string;
  parseStatus: string | null;
  chunks: Array<{ page: number; start: number; text: string }>;
  facts: EvidenceFactInput[];
}

export interface PersistRetryInput {
  materialId: string;
  parseStatus: "complete";
  facts: StoredFact[];
}

export interface RetrySmartExtractionDependencies {
  loadMaterial(materialId: string): Promise<RetryMaterial | undefined>;
  extractSmartFacts(pages: ParsedPage[], source: string): Promise<EvidenceFactInput[]>;
  persistRetry(input: PersistRetryInput): Promise<void>;
  createId(): string;
}

function pagesFromChunks(chunks: Array<{ page: number; start: number; text: string }>): ParsedPage[] {
  const grouped = new Map<number, string[]>();
  for (const chunk of [...chunks].sort((left, right) => left.page - right.page || left.start - right.start)) {
    const page = grouped.get(chunk.page) ?? [];
    page.push(chunk.text);
    grouped.set(chunk.page, page);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, texts]) => ({ page, text: texts.join("\n\n") }));
}

export async function retrySmartExtraction(
  materialId: string,
  dependencies: RetrySmartExtractionDependencies,
): Promise<{ smartFacts: number }> {
  const material = await dependencies.loadMaterial(materialId);
  if (!material) throw new Error("材料不存在");
  if (material.category !== "personal") throw new Error("仅个人材料支持智能提取");

  const smartFacts = await dependencies.extractSmartFacts(pagesFromChunks(material.chunks), material.name);
  const existing = mergeFacts(material.facts);
  const newFacts = mergeFacts(existing, smartFacts).slice(existing.length).map((fact) => ({
    ...fact,
    id: dependencies.createId(),
    materialId,
    confirmed: false,
  }));
  await dependencies.persistRetry({ materialId, parseStatus: "complete", facts: newFacts });
  return { smartFacts: newFacts.length };
}
