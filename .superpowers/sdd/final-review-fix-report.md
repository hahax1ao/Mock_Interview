# Final review fix report

Date: 2026-07-16

## Scope

Completed the five final-review fixes in the isolated `codex/detailed-experience-interviews` worktree. No DashScope request was made and no `jianli.pdf` file was read.

## Findings and TDD evidence

1. Evidence-field salvage
   - Existing uncommitted RED/GREEN retained valid experience fields while clearing only unsupported detail fields.
2. Contact-data minimization
   - RED supplied by the user: phone, email, and address appeared in the model request.
   - GREEN: local candidate windows redact contact lines before invocation; facts, titles, title evidence, detail values, and detail evidence containing contact data are rejected or cleared.
   - Focused result: 1 passed, 33 skipped.
3. Complete multi-chunk extraction
   - RED: `maxTokens` was undefined and 24/36-page inputs made only one invocation.
   - GREEN: inputs are bounded to 10 pages or 12,000 characters per chunk, each call receives 8,000 output tokens, results merge/dedupe, and one failed chunk does not discard successful chunks. The arbitrary 30-experience response cap was removed.
   - Focused result: 2 passed, 32 skipped; complete extraction file: 34 passed.
4. Concurrent retry deduplication and compatible migration
   - RED: concurrent retries returned `[200, 502]` with `SQLITE_BUSY`.
   - GREEN: per-material writes are serialized locally, transient busy writes are retried, and a partial unique index covers `(material_id, type, normalized_key)` for drafts. Inserts use conflict-ignore.
   - Legacy RED/GREEN: duplicate drafts are not deleted. The newest edit receives the canonical normalized key and older duplicates receive deterministic `#legacy:<id>` suffixes before the unique index is created. Confirmed rows remain untouched and later retries do not create replacement drafts.
5. Text-mode research first question
   - RED: a saved prior research transcript still caused the fixed project-first instruction to repeat.
   - GREEN: the direct route queries all persisted transcript events; the instruction is included only when no prior interviewer transcript has role `research`.
   - Focused result: 2 passed.

## Final verification

- `npm test -- --reporter=dot`: 36 files, 164 tests passed.
- `npm run lint`: passed (`tsc --noEmit`).
- `npm run build`: passed. Next.js emitted only the existing multiple-lockfile workspace-root warning.
- `npx playwright test --reporter=dot`: 13 passed.
- `git diff --check`: passed.
