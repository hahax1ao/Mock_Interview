import type { ProfileExperience } from "../domain/experiences";
import type { MaterialChunk } from "../domain/materials";
import { backfillMaterialHashes, sha256, type MaterialHashRow } from "./material-dedup";
import type { ParsedPage } from "./material-parser";
import type { ExtractedExperience } from "./material-smart-extraction";
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

export type StoredExperience = ProfileExperience;
export type MaterialExperienceInput = ExtractedExperience & { materialId: string };

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
  experiences: StoredExperience[];
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
  extractSmartProfile(pages: ParsedPage[], source: string): Promise<{
    facts: EvidenceFactInput[];
    experiences: ExtractedExperience[];
    chunks?: { total: number; succeeded: number; failed: number };
  }>;
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
      experiences: number;
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
    let extractedExperiences: ExtractedExperience[] = [];
    let parseStatus: ParseStatus = "complete";

    if (input.category === "personal") {
      localFacts = dependencies.extractLocalFacts(pages, input.name);
      try {
        const smartProfile = await dependencies.extractSmartProfile(pages, input.name);
        smartFacts = smartProfile.facts;
        extractedExperiences = smartProfile.experiences;
        if ((smartProfile.chunks?.failed ?? 0) > 0) parseStatus = "basic_only";
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
    const storedExperiences = extractedExperiences.map((experience) => ({
      ...experience,
      id: dependencies.createId(),
      materialId,
      status: "draft" as const,
      createdAt,
      updatedAt: createdAt,
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
      experiences: storedExperiences,
    });

    return {
      kind: "created",
      materialId,
      pages: pages.length,
      chunks: chunks.length,
      parseStatus,
      localFacts: storedFacts.filter((fact) => fact.extractor === "local").length,
      smartFacts: storedFacts.filter((fact) => fact.extractor === "qwen").length,
      experiences: storedExperiences.length,
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
  experiences: Array<StoredExperience & { normalizedKey?: string | null }>;
}

export interface PersistRetryInput {
  materialId: string;
  parseStatus: ParseStatus;
  facts: StoredFact[];
  experienceUpdates: StoredExperience[];
  experienceInserts: StoredExperience[];
}

export interface RetrySmartExtractionDependencies {
  loadMaterial(materialId: string): Promise<RetryMaterial | undefined>;
  extractSmartProfile(pages: ParsedPage[], source: string): Promise<{
    facts: EvidenceFactInput[];
    experiences: ExtractedExperience[];
    chunks?: { total: number; succeeded: number; failed: number };
  }>;
  persistRetry(input: PersistRetryInput): Promise<void>;
  createId(): string;
  now(): number;
}

const normalizeExperienceTitle = (title: string) =>
  title.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

const experienceKey = (experience: Pick<StoredExperience, "materialId" | "type" | "title">) =>
  `${experience.materialId}\0${experience.type}\0${normalizeExperienceTitle(experience.title)}`;

export function reconcileExperienceDrafts(
  existing: StoredExperience[],
  extracted: MaterialExperienceInput[],
  createId: () => string,
  now: () => number,
): StoredExperience[] {
  const confirmedKeys = new Set(existing
    .filter((experience) => experience.status === "confirmed")
    .map(experienceKey));
  const draftCandidates = new Map<string, { index: number; canonical: boolean }>();
  existing.forEach((experience, index) => {
    if (experience.status !== "draft") return;
    const key = experienceKey(experience);
    const normalizedTitle = normalizeExperienceTitle(experience.title);
    const normalizedKey = "normalizedKey" in experience ? experience.normalizedKey : undefined;
    if (typeof normalizedKey === "string" && normalizedKey.includes("#legacy:")) return;
    const canonical = normalizedKey === normalizedTitle;
    if (normalizedKey != null && !canonical) return;
    const current = draftCandidates.get(key);
    if (!current || (canonical && !current.canonical)) {
      draftCandidates.set(key, { index, canonical });
    }
  });
  const draftIndexByKey = new Map(
    [...draftCandidates].map(([key, candidate]) => [key, candidate.index]),
  );

  const reconciled = [...existing];
  const handled = new Set<string>();
  const timestamp = now();
  for (const experience of extracted) {
    const key = experienceKey(experience);
    if (handled.has(key) || confirmedKeys.has(key)) continue;
    handled.add(key);
    const draftIndex = draftIndexByKey.get(key);
    if (draftIndex !== undefined) {
      const draft = existing[draftIndex];
      reconciled[draftIndex] = {
        ...experience,
        id: draft.id,
        status: "draft",
        createdAt: draft.createdAt,
        updatedAt: timestamp,
      };
      continue;
    }
    reconciled.push({
      ...experience,
      id: createId(),
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return reconciled;
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
): Promise<{ smartFacts: number; experiences: number }> {
  const material = await dependencies.loadMaterial(materialId);
  if (!material) throw new Error("材料不存在");
  if (material.category !== "personal") throw new Error("仅个人材料支持智能提取");

  const smartProfile = await dependencies.extractSmartProfile(
    pagesFromChunks(material.chunks),
    material.name,
  );
  const existingFacts = mergeFacts(material.facts);
  const newFacts = mergeFacts(existingFacts, smartProfile.facts).slice(existingFacts.length).map((fact) => ({
    ...fact,
    id: dependencies.createId(),
    materialId,
    confirmed: false,
  }));
  const existingById = new Map(material.experiences.map((experience) => [experience.id, experience]));
  const reconciled = reconcileExperienceDrafts(
    material.experiences,
    smartProfile.experiences.map((experience) => ({ ...experience, materialId })),
    dependencies.createId,
    dependencies.now,
  );
  const experienceUpdates = reconciled.filter((experience) => {
    const prior = existingById.get(experience.id);
    return prior !== undefined && prior !== experience;
  });
  const experienceInserts = reconciled.filter((experience) => !existingById.has(experience.id));
  await dependencies.persistRetry({
    materialId,
    parseStatus: (smartProfile.chunks?.failed ?? 0) > 0 ? "basic_only" : "complete",
    facts: newFacts,
    experienceUpdates,
    experienceInserts,
  });
  return { smartFacts: newFacts.length, experiences: experienceUpdates.length + experienceInserts.length };
}
