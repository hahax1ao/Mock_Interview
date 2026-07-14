# Material Management and Hybrid Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact-file deduplication, evidence-checked Qwen profile extraction, safe permanent material deletion, retryable smart parsing, and clear material-library UI feedback.

**Architecture:** Keep binary/text extraction local, move reusable material behavior into focused services, and let API routes orchestrate those services. Deterministic facts come from bounded local patterns; complex facts come from a Zod-validated Qwen response whose evidence must match a stored page before facts may enter SQLite.

**Tech Stack:** Next.js App Router, TypeScript, React, SQLite/libSQL, Drizzle ORM, Zod, OpenAI-compatible DashScope client, Vitest, Playwright.

## Global Constraints

- Exact duplicates are determined by SHA-256 content, not filename.
- Original files, extracted text, hashes, and SQLite data remain local; only extracted text may be sent to DashScope.
- Smart extraction runs only for `personal` materials; `target` and `reference` materials are indexed without profile extraction.
- Missing or failed DashScope access must produce `basic_only`, never roll back a successfully parsed local upload.
- Every persisted smart fact must have an evidence excerpt that matches its declared local page after whitespace normalization.
- Deleting a material removes its file, chunks, and profile facts while preserving interview and review history.
- Default automated tests use mocks and incur no DashScope charges.

---

## File Structure

- Create `src/lib/material-dedup.ts`: SHA-256 hashing and lazy backfill of hashes for legacy rows.
- Create `src/lib/profile-extraction.ts`: local fact extraction, smart-result validation, evidence checks, and fact merging.
- Create `src/lib/material-smart-extraction.ts`: Qwen prompt, Zod response schema, and conversion to evidence-backed facts.
- Create `src/lib/material-deletion.ts`: upload-path validation, quarantine/rollback, and stale-trash cleanup.
- Create `src/app/api/materials/[id]/route.ts`: permanent delete endpoint.
- Create `src/app/api/materials/[id]/retry/route.ts`: retry smart extraction from locally stored chunks.
- Modify `src/db/schema.ts` and `src/db/client.ts`: hash, parse status, fact evidence metadata, and additive migrations.
- Modify `src/app/api/materials/route.ts`: dedup-first upload orchestration and basic/smart status responses.
- Modify `src/lib/material-parser.ts`: retain file parsing only and delegate fact behavior.
- Modify `src/lib/models.ts`: centralized `materialExtraction` model.
- Modify `src/app/page.tsx` and `src/app/globals.css`: delete/retry controls and status feedback.
- Add focused Vitest tests beside each service and extend `e2e/app.spec.ts`.

---

### Task 1: Persist Content Hashes and Parse Metadata

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Create: `src/lib/material-dedup.ts`
- Create: `src/lib/material-dedup.test.ts`
- Modify: `src/lib/database-migration.test.ts`

**Interfaces:**
- Produces: `sha256(buffer: Buffer): string`
- Produces: `backfillMaterialHashes(rows, update): Promise<MaterialHashRow[]>`
- Produces material fields `contentHash`, `parseStatus`; fact fields `evidence`, `page`, `extractor`.

- [ ] **Step 1: Write failing hash and backfill tests**

```ts
it("uses content rather than filename for duplicate identity", () => {
  expect(sha256(Buffer.from("same"))).toBe(sha256(Buffer.from("same")));
  expect(sha256(Buffer.from("same"))).not.toBe(sha256(Buffer.from("different")));
});

it("backfills only readable legacy rows with missing hashes", async () => {
  const updates: Array<[string, string]> = [];
  const rows = await backfillMaterialHashes([
    { id: "old", filePath: fixture, contentHash: null },
    { id: "done", filePath: fixture, contentHash: "known" },
  ], async (id, hash) => { updates.push([id, hash]); });
  expect(updates).toEqual([["old", sha256(await readFile(fixture))]]);
  expect(rows.find((row) => row.id === "done")?.contentHash).toBe("known");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- src/lib/material-dedup.test.ts src/lib/database-migration.test.ts`

Expected: FAIL because the helper and new columns do not exist.

- [ ] **Step 3: Implement the hash service**

```ts
export function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function backfillMaterialHashes(
  rows: MaterialHashRow[],
  update: (id: string, hash: string) => Promise<void>,
) {
  return Promise.all(rows.map(async (row) => {
    if (row.contentHash) return row;
    try {
      const contentHash = sha256(await readFile(row.filePath));
      await update(row.id, contentHash);
      return { ...row, contentHash };
    } catch {
      return row;
    }
  }));
}
```

- [ ] **Step 4: Add nullable schema fields and idempotent migrations**

Add `content_hash`, `parse_status`, `evidence`, `page`, and `extractor` to Drizzle. In `initDatabase`, run one `ALTER TABLE ... ADD COLUMN` per field and ignore only `/duplicate column/i`; use defaults `ready`, empty evidence, page `1`, and extractor `local` for legacy data.

- [ ] **Step 5: Run focused and full tests**

Run: `npm test -- src/lib/material-dedup.test.ts src/lib/database-migration.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all existing tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/db/schema.ts src/db/client.ts src/lib/material-dedup.ts src/lib/material-dedup.test.ts src/lib/database-migration.test.ts
git commit -m "feat: persist material content hashes"
```

---

### Task 2: Make Local Facts Bounded and Evidence-Backed

**Files:**
- Create: `src/lib/profile-extraction.ts`
- Create: `src/lib/profile-extraction.test.ts`
- Modify: `src/lib/material-parser.ts`
- Modify: `src/lib/material-parser.test.ts`

**Interfaces:**
- Produces: `EvidenceFactInput = { field; value; source; confidence; evidence; page; extractor }`.
- Produces: `extractLocalFacts(pages, source): EvidenceFactInput[]`.
- Produces: `mergeFacts(local, smart): EvidenceFactInput[]`.
- Consumes later: smart facts from Task 3.

- [ ] **Step 1: Add regression tests using the actual extracted resume ordering**

```ts
it("does not turn neighboring headings or a name into complex facts", () => {
  const facts = extractLocalFacts([{ page: 1, text: [
    "竞赛经历：", "姓名 沈笑", "GPA：4.043/5（均分 90.5399），专业排名 3/42",
    "语 言 ： CET4:514、CET6:470", "科研经历：", "个人技能：", "其它经历：",
  ].join("\n") }], "jianli.pdf");
  expect(facts).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "专业排名", value: "3/42" }),
    expect.objectContaining({ field: "英语四级", value: "514" }),
  ]));
  expect(facts.some((fact) => ["科研经历", "竞赛经历", "技能"].includes(fact.field))).toBe(false);
});
```

Add tests proving every fact has exact `evidence` and `page`, duplicate field/value pairs merge once, and same-field different-value pairs remain separate.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- src/lib/profile-extraction.test.ts src/lib/material-parser.test.ts`

Expected: FAIL because `extractLocalFacts` and evidence metadata are missing.

- [ ] **Step 3: Implement line-bounded local patterns**

Use per-page matches for `专业排名`, `平均成绩`, `英语四级`, `英语六级`, `目标方向`, and `核心课程`. Do not locally emit projects, research, competitions, skills, or honors. Each match returns the full matched line as evidence; reject blank values and values ending only in `：` or `:`.

```ts
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export function mergeFacts(...groups: EvidenceFactInput[][]) {
  const unique = new Map<string, EvidenceFactInput>();
  for (const fact of groups.flat()) {
    const key = `${normalize(fact.field)}\0${normalize(fact.value)}`;
    if (!unique.has(key)) unique.set(key, fact);
  }
  return [...unique.values()];
}
```

- [ ] **Step 4: Remove fact rules from `material-parser.ts`**

Keep `ParsedPage` and `parseMaterial` in the parser. Re-export `extractLocalFacts` as `extractFacts` for Task 2 compatibility, then switch the route in Task 4 and remove the alias.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/lib/profile-extraction.test.ts src/lib/material-parser.test.ts src/lib/material-pdf.test.ts`

Expected: PASS, including all three `jianli.pdf` false-positive assertions.

```powershell
git add src/lib/profile-extraction.ts src/lib/profile-extraction.test.ts src/lib/material-parser.ts src/lib/material-parser.test.ts
git commit -m "fix: bound local profile fact extraction"
```

---

### Task 3: Add Evidence-Checked Qwen Extraction

**Files:**
- Create: `src/lib/material-smart-extraction.ts`
- Create: `src/lib/material-smart-extraction.test.ts`
- Modify: `src/lib/models.ts`

**Interfaces:**
- Produces: `extractSmartFacts(pages, source, invoke?): Promise<EvidenceFactInput[]>`.
- Produces: `validateSmartEvidence(fact, pages): boolean`.
- Consumes: `qwenJson`, `EvidenceFactInput`, and `models.materialExtraction`.

- [ ] **Step 1: Write failing validation and model-call tests**

Use an injected fake `invoke` so tests never call DashScope. Cover valid evidence, missing evidence, wrong page, heading-only values, malformed fields, and whitespace differences caused by PDF extraction.

```ts
const invoke = async () => ({ facts: [
  { field: "竞赛经历", value: "全国大学生嵌入式芯片与系统设计竞赛全国二等奖",
    evidence: "2025 年 全 国 大 学 生 嵌 入 式 芯 片 与 系 统 设 计 竞 赛 FPGA 赛 道 全 国 二 等 奖",
    page: 1, confidence: 0.9 },
] });
const facts = await extractSmartFacts(pages, "jianli.pdf", invoke);
expect(facts[0]).toMatchObject({ field: "竞赛经历", extractor: "qwen", page: 1 });
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- src/lib/material-smart-extraction.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement schema, prompt, and evidence gate**

Define a Zod object `{ facts: z.array(...) }` with fields limited to `项目经历 | 科研经历 | 竞赛经历 | 技能 | 荣誉`. Cap value/evidence lengths, confidence to `0..1`, and page to a positive integer. Prompt the model to classify semantically even when PDF reading order is wrong, quote exact evidence, return no unsupported facts, and never include contact details.

Normalize NFKC plus whitespace only for evidence comparison. Accept a smart result only when the normalized declared evidence is included in the normalized declared page. Convert accepted results to `EvidenceFactInput` with `extractor: "qwen"` and confidence capped at `0.9`.

- [ ] **Step 4: Centralize the model setting**

```ts
materialExtraction: process.env.QWEN_MATERIAL_MODEL
  ?? process.env.QWEN_ECONOMY_MODEL
  ?? "qwen3.5-flash",
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/lib/material-smart-extraction.test.ts`

Expected: PASS without network access.

```powershell
git add src/lib/material-smart-extraction.ts src/lib/material-smart-extraction.test.ts src/lib/models.ts
git commit -m "feat: extract evidence-backed material facts"
```

---

### Task 4: Orchestrate Deduplicated Upload and Smart Retry

**Files:**
- Modify: `src/app/api/materials/route.ts`
- Create: `src/app/api/materials/[id]/retry/route.ts`
- Create: `src/lib/material-ingestion.ts`
- Create: `src/lib/material-ingestion.test.ts`

**Interfaces:**
- Produces: `ingestMaterial(input, dependencies): Promise<{ parseStatus; localFacts; smartFacts }>`.
- Produces: `retrySmartExtraction(materialId): Promise<{ smartFacts: number }>` through the retry route.
- Consumes: Tasks 1–3 helpers.

- [ ] **Step 1: Write failing ingestion tests**

Cover: exact duplicate returns a typed duplicate result before `parseMaterial` or Qwen runs; same filename/different bytes proceeds; non-personal material skips all profile extraction; Qwen rejection produces `basic_only`; Qwen success produces `complete`; retry inserts only facts not already present.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- src/lib/material-ingestion.test.ts`

Expected: FAIL because the ingestion service does not exist.

- [ ] **Step 3: Implement ingestion as a dependency-injected service**

Compute and compare hashes first. After parsing, call local and smart extraction only for `personal`. Merge results before insertion. Persist the material, chunks, and facts in a database transaction. If parsing fails after the file was written, remove only the newly created upload directory.

Return:

```ts
type IngestionResult =
  | { kind: "duplicate"; material: { id: string; name: string; createdAt: number } }
  | { kind: "created"; materialId: string; pages: number; chunks: number;
      parseStatus: "complete" | "basic_only"; localFacts: number; smartFacts: number };
```

- [ ] **Step 4: Make `POST /api/materials` use the service**

Return HTTP 409 with `{ error: "该材料已上传", duplicateMaterial }` for duplicates. Return HTTP 201 with parse counts and status for created materials. Preserve 20 MB and category validation.

- [ ] **Step 5: Add smart retry from stored chunks**

The retry route loads the material and its chunks, rejects non-personal material with HTTP 400, groups chunks by page, calls smart extraction, merges against existing facts, inserts only new keys, and sets `parseStatus` to `complete`. A failed model call returns a readable error and leaves current facts/status intact.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- src/lib/material-ingestion.test.ts`

Expected: PASS.

Run: `npm test`

Expected: full suite PASS.

```powershell
git add src/app/api/materials/route.ts src/app/api/materials/[id]/retry/route.ts src/lib/material-ingestion.ts src/lib/material-ingestion.test.ts
git commit -m "feat: deduplicate and retry material ingestion"
```

---

### Task 5: Delete Materials with Quarantine and Rollback

**Files:**
- Create: `src/lib/material-deletion.ts`
- Create: `src/lib/material-deletion.test.ts`
- Create: `src/app/api/materials/[id]/route.ts`
- Modify: `src/db/cascade.test.ts`
- Modify: `src/db/client.ts`

**Interfaces:**
- Produces: `deleteMaterialSafely(input, deleteRecord): Promise<{ cleanupPending: boolean }>`.
- Produces: `cleanupMaterialTrash(storageRoot): Promise<void>`.

- [ ] **Step 1: Write failing filesystem and cascade tests**

Test normal deletion, rejection of a path outside `<storageRoot>/uploads/<materialId>`, restoration when `deleteRecord` throws, and stale trash cleanup. Add a database test where deleting a material removes its chunks/facts but leaves an interview whose JSON snapshot contains that material ID.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- src/lib/material-deletion.test.ts src/db/cascade.test.ts`

Expected: FAIL because deletion helpers are missing.

- [ ] **Step 3: Implement quarantine deletion**

Resolve and compare absolute paths with `relative()`; reject paths where the relative result starts with `..`, is absolute, or the parent directory basename differs from `materialId`. Rename the upload directory to `<storageRoot>/trash/<materialId>-<uuid>`, call the injected database deletion, restore on database failure, then recursively remove quarantine. Return `cleanupPending: true` if only final trash cleanup fails.

- [ ] **Step 4: Implement `DELETE /api/materials/:id`**

Load the material or return 404. Call `deleteMaterialSafely` with a Drizzle transaction that deletes the material row; rely on existing foreign-key cascades for chunks/facts. Return `{ deletedId, cleanupPending }`.

- [ ] **Step 5: Clean stale trash during database initialization**

Call `cleanupMaterialTrash(storageRoot)` after the database is initialized. Cleanup errors should log only the error class/message and must not prevent app startup.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- src/lib/material-deletion.test.ts src/db/cascade.test.ts`

Expected: PASS.

```powershell
git add src/lib/material-deletion.ts src/lib/material-deletion.test.ts src/app/api/materials/[id]/route.ts src/db/cascade.test.ts src/db/client.ts
git commit -m "feat: safely delete local materials"
```

---

### Task 6: Add Material Library Controls and Feedback

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/app.spec.ts`

**Interfaces:**
- Consumes: upload `parseStatus`, duplicate HTTP 409 payload, delete endpoint, retry endpoint.
- Produces: accessible delete/retry buttons and immediate state refresh.

- [ ] **Step 1: Add failing Playwright scenarios**

Mock material APIs with `page.route`. Verify an exact duplicate displays the existing material message; clicking `删除 jianli.pdf` opens a filename-bearing confirmation; accepting sends DELETE and removes its facts and selected ID; `basic_only` displays `智能解析待重试`; retry success refreshes facts.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:e2e -- --grep "material library"`

Expected: FAIL because the controls and messages are absent.

- [ ] **Step 3: Implement UI state and actions**

Extend `Material` with `status`, `parseStatus`, and `createdAt`. Track `deletingId` and `retryingId`. Use `window.confirm(\`永久删除“${item.name}”及其画像事实？\`)`. On success, filter `materials`, `facts`, `selected`, and `factValues` before calling `refresh()`; disable the active button. Render retry only for personal materials with `basic_only`.

For upload 409, render `已存在相同材料：<name>（<time>）` rather than a generic failure. For 201, distinguish complete and basic-only parsing in the notice.

- [ ] **Step 4: Add compact destructive/control styles**

Keep the existing visual language. Place controls at the right of `.file-row`, use a restrained red outline for delete, a green outline for retry, visible focus states, and stack controls under file metadata on narrow screens.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:e2e -- --grep "material library"`

Expected: PASS.

Run: `npm run lint`

Expected: TypeScript exits 0.

```powershell
git add src/app/page.tsx src/app/globals.css e2e/app.spec.ts
git commit -m "feat: manage materials from the local library"
```

---

### Task 7: Full Regression and Real Resume Acceptance

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Verifies all prior task outputs together.

- [ ] **Step 1: Run all automated verification**

Run: `npm test`

Expected: all Vitest tests PASS with no real DashScope calls.

Run: `npm run lint`

Expected: `tsc --noEmit` exits 0.

Run: `npm run build`

Expected: Next.js production build exits 0.

Run: `npm run test:e2e`

Expected: all Chromium scenarios PASS.

- [ ] **Step 2: Run a manual real-API upload using `test_thing/jianli.pdf` in an isolated data directory**

Start the acceptance server from PowerShell with `$env:BAOYAN_DATA_DIR='.tmp/material-acceptance'; npm run dev`, so the test cannot change the user's existing material library.

Expected:

- one upload is created with `parseStatus: complete`;
- a second byte-identical upload returns HTTP 409 before another Qwen request;
- no fact maps `竞赛经历` to `姓名 沈笑`;
- no fact maps `科研经历` to `个人技能：`;
- no fact maps `技能` to `其它经历：`;
- project, competition, and skill facts contain evidence found in page 1;
- deleting the test material removes its upload directory, chunks, and facts.

- [ ] **Step 3: Document configuration and privacy behavior**

Add `QWEN_MATERIAL_MODEL=qwen3.5-flash` to `.env.example` and explain that material text, not original files, is sent to DashScope during smart parsing. Preserve all unrelated README edits already in the dirty worktree.

- [ ] **Step 4: Request code review and address only verified findings**

Use `superpowers:requesting-code-review`, review the complete diff against the approved design, and rerun the affected focused tests after every accepted correction.

- [ ] **Step 5: Final verification commit**

```powershell
git add .env.example README.md
git commit -m "docs: explain smart material parsing"
```

Do not stage unrelated pre-existing changes.
