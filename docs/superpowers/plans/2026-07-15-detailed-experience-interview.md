# Detailed Experience Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every substantially described research, project, and competition experience into an editable, evidence-backed card and force the research interview module to prioritize a confirmed card.

**Architecture:** Extend the existing single DashScope material-profile call so it returns both flat facts and structured experiences. Persist experience drafts in a dedicated SQLite table, expose card editing and confirmation APIs, and place the selected confirmed experience ahead of generic chunks in both realtime and text interview control instructions.

**Tech Stack:** Next.js 16, TypeScript 5.9, React 19, SQLite/libSQL, Drizzle ORM, Zod, DashScope OpenAI-compatible API, Vitest, Testing Library, Playwright.

## Global Constraints

- Work in a `superpowers:using-git-worktrees` worktree because the main checkout contains the user's uncommitted `next-env.d.ts` and `test_thing/` state.
- Follow strict TDD: add one failing test, verify the expected failure, implement the minimum behavior, and rerun the focused test before each commit.
- Original PDF, DOCX, and image files remain local; only locally extracted text may be sent to DashScope.
- Detailed-experience detection is semantic and generic. Do not hardcode Super-LoRa, the embedded FPGA contest, the electronic design contest, or any other project name as extraction triggers.
- A valid experience requires a title plus at least one detail field. Every model-produced non-empty field, including the title, requires same-page source evidence.
- Re-extraction may update unconfirmed drafts but must never overwrite confirmed cards.
- Vitest and Playwright use mocks by default and must not spend DashScope balance.
- Markdown formulas, if any are later added, use dollar-delimited inline and block syntax required by `AGENTS.md`.

---

### Task 1: Add the detailed-experience domain model and database migration

**Files:**
- Create: `src/domain/experiences.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Modify: `src/lib/database-migration.test.ts`
- Modify: `src/db/cascade.test.ts`

**Interfaces:**
- Produces: `ExperienceType`, `ExperienceEvidence`, `ProfileExperience`, `experienceEditableSchema`, and the Drizzle `profileExperiences` table.
- Consumes: the existing `materials` table and `initDatabase()` migration convention.

- [ ] **Step 1: Write the failing migration and cascade tests**

Add assertions that `profile_experiences` exists with the required columns and that deleting its source material removes the card:

```ts
const info = await db.run(sql`PRAGMA table_info(profile_experiences)`);
expect(info.rows.map((column) => column.name)).toEqual(expect.arrayContaining([
  "id", "material_id", "type", "title", "background", "responsibilities",
  "methods", "results", "award_role", "source", "page", "evidence",
  "confidence", "status", "created_at", "updated_at",
]));

await db.insert(profileExperiences).values({
  id: experienceId,
  materialId,
  type: "research",
  title: "载荷叠加通信研究",
  background: "提升 IoT 吞吐量",
  responsibilities: "实现物理层驱动",
  methods: "SDR 与 De-chirp",
  results: "吞吐量提升 1.35 倍",
  awardRole: "",
  source: "resume.pdf",
  page: 1,
  evidence: { title: "载荷叠加通信研究", results: "吞吐量提升 1.35 倍" },
  confidence: 0.9,
  status: "draft",
  createdAt: 1,
  updatedAt: 1,
});
await db.delete(materials).where(eq(materials.id, materialId));
expect(await db.select().from(profileExperiences).where(eq(profileExperiences.materialId, materialId))).toEqual([]);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- src/lib/database-migration.test.ts src/db/cascade.test.ts
```

Expected: FAIL because `profileExperiences` and `profile_experiences` do not exist.

- [ ] **Step 3: Define the domain types and edit schema**

Create `src/domain/experiences.ts`:

```ts
import { z } from "zod";

export const ExperienceTypeSchema = z.enum(["research", "project", "competition"]);
export type ExperienceType = z.infer<typeof ExperienceTypeSchema>;

export const ExperienceEvidenceSchema = z.object({
  title: z.string().trim().min(1),
  background: z.string().trim().min(1).optional(),
  responsibilities: z.string().trim().min(1).optional(),
  methods: z.string().trim().min(1).optional(),
  results: z.string().trim().min(1).optional(),
  awardRole: z.string().trim().min(1).optional(),
}).strict();

export type ExperienceEvidence = z.infer<typeof ExperienceEvidenceSchema>;

export const ExperienceEditableObjectSchema = z.object({
  type: ExperienceTypeSchema,
  title: z.string().trim().min(1).max(300),
  background: z.string().trim().max(2_000).default(""),
  responsibilities: z.string().trim().max(2_000).default(""),
  methods: z.string().trim().max(4_000).default(""),
  results: z.string().trim().max(2_000).default(""),
  awardRole: z.string().trim().max(1_000).default(""),
});

export const experienceEditableSchema = ExperienceEditableObjectSchema.refine((value) => [
  value.background, value.responsibilities, value.methods, value.results, value.awardRole,
].some((field) => field.length > 0), { message: "详细经历至少需要一项描述" });

export type ExperienceEditable = z.infer<typeof ExperienceEditableObjectSchema>;

export type ProfileExperience = z.infer<typeof experienceEditableSchema> & {
  id: string;
  materialId: string;
  source: string;
  page: number;
  evidence: ExperienceEvidence;
  confidence: number;
  status: "draft" | "confirmed";
  createdAt: number;
  updatedAt: number;
};
```

- [ ] **Step 4: Add the Drizzle table and idempotent startup migration**

Add to `src/db/schema.ts`:

```ts
export const profileExperiences = sqliteTable("profile_experiences", {
  id: text("id").primaryKey(),
  materialId: text("material_id").notNull().references(() => materials.id, { onDelete: "cascade" }),
  type: text("type").$type<"research" | "project" | "competition">().notNull(),
  title: text("title").notNull(),
  background: text("background").notNull().default(""),
  responsibilities: text("responsibilities").notNull().default(""),
  methods: text("methods").notNull().default(""),
  results: text("results").notNull().default(""),
  awardRole: text("award_role").notNull().default(""),
  source: text("source").notNull(),
  page: integer("page").notNull(),
  evidence: text("evidence", { mode: "json" }).$type<ExperienceEvidence>().notNull(),
  confidence: real("confidence").notNull(),
  status: text("status").$type<"draft" | "confirmed">().notNull().default("draft"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

Import `ExperienceEvidence`, then add this migration to `initDatabase()` after `profile_facts`:

```sql
CREATE TABLE IF NOT EXISTS profile_experiences (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  background TEXT NOT NULL DEFAULT '',
  responsibilities TEXT NOT NULL DEFAULT '',
  methods TEXT NOT NULL DEFAULT '',
  results TEXT NOT NULL DEFAULT '',
  award_role TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  page INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- src/lib/database-migration.test.ts src/db/cascade.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/domain/experiences.ts src/db/schema.ts src/db/client.ts src/lib/database-migration.test.ts src/db/cascade.test.ts
git commit -m "feat: persist detailed profile experiences"
```

---

### Task 2: Extract generic evidence-backed experience cards in the existing smart-profile call

**Files:**
- Modify: `src/lib/material-smart-extraction.ts`
- Modify: `src/lib/material-smart-extraction.test.ts`

**Interfaces:**
- Consumes: `ExperienceTypeSchema`, `ExperienceEvidenceSchema`, `ParsedPage`, and `qwenJson`.
- Produces: `ExtractedExperience` and `extractSmartMaterialProfile(pages, source, invoke)` returning `{ facts, experiences }` from one paid request.

- [ ] **Step 1: Add a failing three-experience contract test**

Use fixed material text containing one anonymous research project, one embedded contest system, and one electronic-design contest system. The mock response should contain three semantically distinct cards and the test should assert all detail fields survive:

```ts
const pages = [{ page: 1, text: [
  "高吞吐量通信协议研究与全链路验证",
  "项目目标：解决数据密集型 IoT 速率受限问题。",
  "实现内容：完成物理层驱动、SDR 链路与滑动窗口解调。",
  "结果：有效吞吐量达到标准协议的 1.35 倍。",
  "全国大学生嵌入式芯片与系统设计竞赛",
  "队长，负责 FPGA 与上位机，开发智能会议相机，丢包率小于 1%。",
  "全国大学生电子设计竞赛 G 题",
  "队长，负责 FPGA 与硬件电路，实现未知 RLC 网络识别。",
].join("\n") }];

const result = await extractSmartMaterialProfile(pages, "resume.pdf", async () => ({
  facts: [],
  experiences: [researchCard, embeddedCard, electronicDesignCard],
}));

expect(result.experiences).toHaveLength(3);
expect(result.experiences.map((item) => item.type)).toEqual(["research", "competition", "competition"]);
expect(result.experiences[0].results).toContain("1.35 倍");
expect(result.experiences[1].responsibilities).toContain("FPGA 与上位机");
expect(result.experiences[2].methods).toContain("RLC 网络识别");
```

Use generic replacement titles in a second test to prove no project-name allowlist is required.

- [ ] **Step 2: Add failing evidence rejection tests**

Add separate tests for an invented title, a detail whose evidence is absent, an invalid page, and a title-only card. Each invalid card must be removed while valid cards remain.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
npm test -- src/lib/material-smart-extraction.test.ts
```

Expected: FAIL because `extractSmartMaterialProfile` and `experiences` are not implemented.

- [ ] **Step 4: Extend the strict Zod response contract**

Define the model-side card schema in `material-smart-extraction.ts`:

```ts
const extractedExperienceSchema = ExperienceEditableObjectSchema.extend({
  page: z.number().int().positive(),
  evidence: ExperienceEvidenceSchema,
  confidence: z.number().min(0).max(1),
}).strict();

export type ExtractedExperience = z.infer<typeof extractedExperienceSchema> & { source: string };

const smartExtractionSchema = z.object({
  facts: z.array(smartFactSchema).max(100),
  experiences: z.array(extractedExperienceSchema).max(30),
}).strict();
```

Apply the same at-least-one-detail refinement to `extractedExperienceSchema` after extending the object schema.

- [ ] **Step 5: Implement same-page evidence validation and generic filtering**

Add helpers that validate every non-empty field and deduplicate by normalized type/title:

```ts
const detailFields = ["background", "responsibilities", "methods", "results", "awardRole"] as const;

function validatesExperienceEvidence(experience: ExtractedExperience, pages: ParsedPage[]) {
  const page = pages.find((candidate) => candidate.page === experience.page);
  if (!page || !containsEvidence(page.text, experience.evidence.title)) return false;
  if (!detailFields.some((field) => experience[field].trim().length > 0)) return false;
  return detailFields.every((field) => {
    if (!experience[field].trim()) return experience.evidence[field] === undefined;
    const evidence = experience.evidence[field];
    return typeof evidence === "string" && containsEvidence(page.text, evidence);
  });
}
```

Update the system prompt to require one card per distinct, substantially described experience; forbid merging unrelated experiences; forbid name-based allowlists; and return the exact root shape `{"facts":[],"experiences":[]}`.

- [ ] **Step 6: Keep a compatibility wrapper without a second API call**

Implement:

```ts
export async function extractSmartMaterialProfile(/* existing arguments */) {
  const parsed = smartExtractionSchema.parse(await invoke(/* one qwenJson request */));
  return {
    facts: filterSmartFacts(parsed.facts, pages, source),
    experiences: filterExperiences(parsed.experiences, pages, source),
  };
}
```

Remove direct production use of `extractSmartFacts`; if tests or external imports need temporary compatibility, make it a pure result mapper supplied with an already-resolved profile rather than issuing a second request.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- src/lib/material-smart-extraction.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/domain/experiences.ts src/lib/material-smart-extraction.ts src/lib/material-smart-extraction.test.ts
git commit -m "feat: extract detailed experience cards"
```

---

### Task 3: Persist cards atomically on upload and safely reconcile drafts on re-extraction

**Files:**
- Modify: `src/lib/material-ingestion.ts`
- Modify: `src/lib/material-ingestion.test.ts`
- Modify: `src/lib/material-reservations.ts`
- Modify: `src/lib/material-reservations.test.ts`
- Modify: `src/app/api/materials/route.ts`
- Modify: `src/app/api/materials/[id]/retry/route.ts`
- Modify: `src/app/api/materials/route.test.ts`

**Interfaces:**
- Consumes: `extractSmartMaterialProfile` and `profileExperiences`.
- Produces: upload/retry results containing `smartFacts` and `experiences`, and `reconcileExperienceDrafts(existing, extracted, createId, now)`.

- [ ] **Step 1: Write failing ingestion tests**

Add tests asserting:

```ts
expect(result).toEqual(expect.objectContaining({
  kind: "created",
  smartFacts: 1,
  experiences: 3,
}));
expect(persisted.experiences).toHaveLength(3);
```

Add a retry test where an existing matching draft keeps its ID and is updated, a new draft is inserted, and a confirmed card with the same normalized key is returned unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- src/lib/material-ingestion.test.ts src/lib/material-reservations.test.ts
```

Expected: FAIL because ingestion and reserved persistence do not accept experiences.

- [ ] **Step 3: Extend ingestion contracts**

Replace the smart dependency with one call:

```ts
extractSmartProfile(pages: ParsedPage[], source: string): Promise<{
  facts: EvidenceFactInput[];
  experiences: ExtractedExperience[];
}>;
```

Add `experiences: StoredExperience[]` to `PersistCreatedInput`, and include an `experiences` count in the created result. During personal-material ingestion, catch the single smart-profile call; on failure retain local facts, set `parseStatus` to `basic_only`, and persist zero new experiences.

- [ ] **Step 4: Implement deterministic draft reconciliation**

Add a pure helper whose key is `${materialId}\0${type}\0${normalize(title)}`. For each extracted card:

- Skip it if a confirmed card already has the key.
- Reuse the ID and `createdAt` of a matching draft while replacing model fields and `updatedAt`.
- Otherwise create a new draft ID.
- Return stale unmatched drafts unchanged; re-extraction is additive and must not silently delete a user's draft.

The returned array is then persisted with explicit updates and inserts inside one transaction.

- [ ] **Step 5: Insert upload experiences inside the reservation transaction**

Update `persistReservedMaterial`:

```ts
await tx.insert(materials).values(input.material);
if (input.chunks.length) await tx.insert(materialChunks).values(input.chunks);
if (input.facts.length) await tx.insert(profileFacts).values(input.facts);
if (input.experiences.length) await tx.insert(profileExperiences).values(input.experiences);
```

Extend the fencing rollback test so a forced later insert failure leaves materials, chunks, facts, experiences, and reservation state unchanged.

- [ ] **Step 6: Wire upload and retry routes**

In `POST /api/materials`, pass `extractSmartMaterialProfile` and return the experience count. In `POST /api/materials/:id/retry`, load existing experiences regardless of `parseStatus`, invoke the one smart-profile call, reconcile drafts, and atomically persist fact additions, card updates/inserts, and `parseStatus: "complete"`.

- [ ] **Step 7: Run focused tests and verify GREEN**

```powershell
npm test -- src/lib/material-ingestion.test.ts src/lib/material-reservations.test.ts src/app/api/materials/route.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/material-ingestion.ts src/lib/material-ingestion.test.ts src/lib/material-reservations.ts src/lib/material-reservations.test.ts src/app/api/materials/route.ts src/app/api/materials/route.test.ts src/app/api/materials/[id]/retry/route.ts
git commit -m "feat: ingest and retry experience cards"
```

---

### Task 4: Expose card listing, editing, and whole-card confirmation APIs

**Files:**
- Modify: `src/app/api/materials/route.ts`
- Create: `src/app/api/experiences/[id]/route.ts`
- Create: `src/app/api/experiences/[id]/route.test.ts`
- Create: `src/app/api/experiences/[id]/confirm/route.ts`
- Create: `src/app/api/experiences/[id]/confirm/route.test.ts`

**Interfaces:**
- Produces: `PATCH /api/experiences/:id` and `POST /api/experiences/:id/confirm`.
- Consumes: `experienceEditableSchema`, `profileExperiences`, and `GET /api/materials`.

- [ ] **Step 1: Write failing route tests**

Cover these cases:

```ts
expect(await patchResponse.json()).toEqual(expect.objectContaining({
  experience: expect.objectContaining({ title: "用户修正标题", status: "draft" }),
}));
expect(confirmResponse.status).toBe(200);
expect((await confirmResponse.json()).experience.status).toBe("confirmed");
```

Also assert 404 for a missing card, 400 for an empty-detail card, and that editing a confirmed card explicitly returns it to `draft` without changing `evidence`, `source`, `page`, `confidence`, or `createdAt`.

- [ ] **Step 2: Run route tests and verify RED**

```powershell
npm test -- src/app/api/experiences/[id]/route.test.ts src/app/api/experiences/[id]/confirm/route.test.ts
```

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement PATCH with strict field ownership**

Parse only editable fields with `experienceEditableSchema`, update them plus `status: "draft"` and `updatedAt`, and never accept provenance fields from the browser. Use `returning()` and return 404 if no row matched.

- [ ] **Step 4: Implement atomic whole-card confirmation**

Parse the complete editable card, update all editable fields and `status: "confirmed"` in one statement, and return the row. This allows a user-confirmed paraphrase while preserving the original source evidence separately.

- [ ] **Step 5: Include cards in material GET**

Query `profileExperiences` and return:

```ts
return NextResponse.json({ materials: items, facts, experiences });
```

- [ ] **Step 6: Run route tests and verify GREEN**

```powershell
npm test -- src/app/api/experiences/[id]/route.test.ts src/app/api/experiences/[id]/confirm/route.test.ts src/app/api/materials/route.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/app/api/materials/route.ts src/app/api/experiences
git commit -m "feat: edit and confirm experience cards"
```

---

### Task 5: Add editable experience cards to the personal portrait UI

**Files:**
- Create: `src/components/experience-cards.tsx`
- Create: `src/components/experience-cards.test.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/app.spec.ts`

**Interfaces:**
- Consumes: the `experiences` array from `GET /api/materials`.
- Produces: `ExperienceCards` with `onSave`, `onConfirm`, and visible incomplete-field hints.

- [ ] **Step 1: Write a failing component test**

Render a Super-LoRa draft and assert expand/edit/confirm behavior:

```tsx
render(<ExperienceCards
  experiences={[experience]}
  busyId={null}
  onSave={onSave}
  onConfirm={onConfirm}
/>);
await user.click(screen.getByRole("button", { name: /展开.*Super-LoRa/ }));
await user.clear(screen.getByLabelText("量化成果"));
await user.type(screen.getByLabelText("量化成果"), "吞吐量提升 1.35 倍");
await user.click(screen.getByRole("button", { name: "确认整张经历" }));
expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ results: "吞吐量提升 1.35 倍" }));
```

Add a second test asserting confirmed cards are read-only until “重新编辑” is clicked.

- [ ] **Step 2: Run the component test and verify RED**

```powershell
npm test -- src/components/experience-cards.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the focused card component**

Keep local drafts keyed by card ID. Render `<details>` cards with labels for type, title, background, responsibilities, methods, results, and award/role. Show source page, confidence, status, and a missing-field summary. A draft submits all editable fields once; confirmed cards expose only “重新编辑”.

- [ ] **Step 4: Wire page state and API actions**

In `page.tsx`, add `experiences`, `experienceBusyId`, and refresh assignment. Implement:

```ts
async function saveExperience(id: string, value: ExperienceEditable) {
  return updateExperience(id, "PATCH", value);
}

async function confirmExperience(id: string, value: ExperienceEditable) {
  return updateExperience(id, "POST", value, "/confirm");
}
```

Render “详细经历” below ordinary facts. Show “重新提取详细经历” for every personal material, not only `basic_only`, while preserving the existing label for a failed smart parse.

- [ ] **Step 5: Add Playwright coverage**

Mock one draft card and verify it expands, edits, confirms via `POST /api/experiences/:id/confirm`, becomes read-only after refresh, and disappears with its material after deletion. Add a retry test for a `complete` material to prove old uploads can extract cards without re-upload.

- [ ] **Step 6: Run focused UI tests and verify GREEN**

```powershell
npm test -- src/components/experience-cards.test.tsx
npm run test:e2e -- --grep "detailed experience|re-extract"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/components/experience-cards.tsx src/components/experience-cards.test.tsx src/app/page.tsx src/app/globals.css e2e/app.spec.ts
git commit -m "feat: manage detailed experience cards"
```

---

### Task 6: Prioritize a confirmed core experience in realtime, text, and review contexts

**Files:**
- Create: `src/lib/experience-interview.ts`
- Create: `src/lib/experience-interview.test.ts`
- Modify: `src/lib/interview-context.ts`
- Modify: `src/lib/interview-context.test.ts`
- Modify: `src/app/api/realtime/session/route.ts`
- Modify: `src/app/api/interviews/[id]/text/route.ts`
- Modify: `src/hooks/use-realtime-interview.ts`
- Modify: `src/hooks/use-realtime-interview.test.ts`
- Modify: `src/hooks/realtime-lifecycle.test.ts`

**Interfaces:**
- Produces: `selectCoreExperience(experiences, focus)`, `formatCoreExperience(experience)`, and `buildResearchHandoffInstruction(interviewId)`.
- Extends realtime session JSON with `roleInstructions: { research?: string }`.

- [ ] **Step 1: Write failing deterministic selection tests**

Create confirmed and draft fixtures and assert selection order: focus relevance, completeness, quantitative result, then `createdAt` and `id`. Assert drafts are excluded.

```ts
expect(selectCoreExperience(experiences, "通信与信号处理")?.title).toBe("高吞吐量通信协议研究");
expect(selectCoreExperience([draftOnly], "通信")).toBeUndefined();
```

- [ ] **Step 2: Write a failing context completeness test**

Pass a confirmed card whose methods and results occur beyond the first 800 characters of the raw material. Assert the formatted context contains title, responsibilities, full methods, results, source, and page before ordinary `画像：` and `资料：` lines.

- [ ] **Step 3: Write a failing realtime handoff test**

Mock `/api/realtime/session` returning:

```ts
{
  websocketPath: "/realtime?token=test",
  roleInstructions: {
    research: "核心经历：高吞吐量通信协议研究。第一问必须点名该经历并询问个人职责。",
  },
}
```

Advance the fake clock from technical to research and assert the outgoing `response.create` instruction contains that exact core-experience requirement.

- [ ] **Step 4: Run focused tests and verify RED**

```powershell
npm test -- src/lib/experience-interview.test.ts src/lib/interview-context.test.ts src/hooks/use-realtime-interview.test.ts src/hooks/realtime-lifecycle.test.ts
```

Expected: FAIL because selection, formatted cards, and role instructions are absent.

- [ ] **Step 5: Implement selection and compact formatting**

Score only confirmed cards. Reuse the existing character relevance idea for title and detail fields, add one point per non-empty detail, add one point if `results` contains a digit, and use stable time/ID tie-breaking. Format the selected card as:

```text
【已确认核心经历】
类型：科研
名称：高吞吐量通信协议研究
背景目标：解决数据密集型 IoT 场景的速率限制
个人职责：完成物理层驱动与 SDR 链路验证
技术方法：实现 CFO 补偿与滑动窗口 De-chirp 解调
量化成果：吞吐量提升至 1.35 倍，SNR 为 -12dB 时误包率低于 5%
来源：resume.pdf 第1页
```

Do not apply the ordinary 20-fact or 800-character excerpt limits to this structured block.

- [ ] **Step 6: Query cards in interview context and generate the research instruction**

Update `buildInterviewContext` to query `profileExperiences` for selected material IDs and prepend all confirmed cards, with the selected core card first. Implement `buildResearchHandoffInstruction` so it returns the selected card summary plus:

```text
科研项目模块的第一问必须点名这项经历并询问候选人的个人职责。后续按动机与职责、技术方法、实验结果、局限与改进追问；同一主题最多三层。
```

If no confirmed card exists, return `undefined` and preserve current generic behavior.

- [ ] **Step 7: Wire realtime and text-mode controls**

Have `POST /api/realtime/session` return `roleInstructions.research`. Store it in a ref inside `useRealtimeInterview`; when the timed handoff enters `research`, append it to the existing forced role-switch instruction. Reconnects during research must reuse it.

In text mode, append the same instruction to the system message whenever `input.role === "research"`. The review pipeline already consumes `buildInterviewContext`, so it receives the confirmed structured evidence automatically.

- [ ] **Step 8: Run focused tests and verify GREEN**

```powershell
npm test -- src/lib/experience-interview.test.ts src/lib/interview-context.test.ts src/hooks/use-realtime-interview.test.ts src/hooks/realtime-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/lib/experience-interview.ts src/lib/experience-interview.test.ts src/lib/interview-context.ts src/lib/interview-context.test.ts src/app/api/realtime/session/route.ts src/app/api/interviews/[id]/text/route.ts src/hooks/use-realtime-interview.ts src/hooks/use-realtime-interview.test.ts src/hooks/realtime-lifecycle.test.ts
git commit -m "feat: prioritize confirmed project experiences"
```

---

### Task 7: Complete regression verification and optional real-resume acceptance

**Files:**
- Modify: `README.md`
- Modify: `e2e/app.spec.ts`
- Do not commit: `test_thing/jianli.pdf`, local databases, API keys, logs, or extracted resume text.

**Interfaces:**
- Verifies all earlier tasks as one local workflow.

- [ ] **Step 1: Add the final failing end-to-end scenario before any final UI adjustment**

The mocked scenario must load three experience cards, confirm the Super-LoRa card, select its source material, create an interview, and verify the realtime session response includes a research role instruction naming that card. If the UI requires a small accessibility fix for stable selectors, make it only after observing the expected failure.

- [ ] **Step 2: Run the targeted scenario and verify RED, then apply the minimum correction**

```powershell
npm run test:e2e -- --grep "confirmed detailed experience drives research interview"
```

Expected before the final wiring correction: FAIL at the missing research instruction. Expected after correction: PASS.

- [ ] **Step 3: Document user behavior and privacy**

Update `README.md` with:

- Old completed materials can use “重新提取详细经历”.
- Draft cards are editable and become interview evidence only after whole-card confirmation.
- Research interviews prioritize a confirmed card.
- Only extracted text, not the original file, is sent to DashScope.

- [ ] **Step 4: Run all automated verification**

Run in order:

```powershell
npm test
npm run lint
npm run build
npm run test:e2e
git diff --check
```

Expected: all Vitest files pass, TypeScript succeeds, Next.js production build succeeds, all Playwright tests pass, and `git diff --check` emits no errors.

- [ ] **Step 5: Perform real `jianli.pdf` acceptance only after renewed explicit authorization**

Use an isolated `BAOYAN_DATA_DIR` and send only the locally extracted text to DashScope. Acceptance requires at least three separate draft cards:

- Super-LoRa research: goal, hardware/SDR work, algorithm method, and quantitative performance.
- Embedded FPGA competition: contest/role, smart meeting camera background, FPGA/PCB/software implementation, and packet-loss result.
- Electronic design contest G task: contest/role, circuit-model device, FPGA/hardware responsibility, and RLC-network identification implementation.

Also inspect the complete extracted output for any additional substantially described experience and require a separate card under the generic rule. Confirm that contact information is absent, evidence is locatable, the original PDF was not uploaded, and the user's normal local database was untouched.

- [ ] **Step 6: Commit**

```powershell
git add README.md e2e/app.spec.ts
git commit -m "docs: explain detailed experience interviews"
```

- [ ] **Step 7: Request final code review and finish the branch**

Invoke `superpowers:requesting-code-review`, address all Critical and Important findings with fresh failing tests, rerun the full verification commands, then invoke `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch`.
