# Second final-review fix report

## Scope

Resolved all five Important findings without reading `jianli.pdf`, sending resume text, or calling DashScope.

## Sequential TDD evidence

1. PII sanitization: RED exposed the second email and misclassified an 11-digit technical metric; GREEN covers optional-separator labels, multiple emails/phones, input and structured output sanitization, and metric retention.
2. Oversized pages: RED sent a 50,135-character single-page request; GREEN bounds each invocation to at most 12,000 characters in the test and merges same-page evidence across chunks.
3. Normalized draft integrity: RED reproduced a genuine canonical/legacy collision and PATCH key drift; GREEN selects only the canonical normalized draft, updates `normalizedKey` atomically, and maps conflicts to 409.
4. Initial research concurrency: RED produced competing first-research requests; GREEN serializes per interview and uses a durable leased claim completed with transcripts in one transaction. Model failure releases the claim for retry.
5. Partial extraction status: RED persisted partial upload and retry results as complete; GREEN retains recovered facts/cards while persisting `basic_only`, which the existing UI exposes as retryable.

## Automated verification

- `npm run lint`: passed
- `npm test`: 36 files, 171 tests passed
- `npm run build`: passed
- `npm run test:e2e`: 13 tests passed
- `git diff --check`: passed

Next.js emitted only the existing nested-worktree multiple-lockfile root warning.