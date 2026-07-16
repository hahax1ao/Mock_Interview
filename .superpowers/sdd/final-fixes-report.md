# V1.1 final fixes report

Date: 2026-07-16

## Scope

Completed the five final-review repair areas in the isolated `codex/v1.1-question-coverage` worktree. No real DashScope request was made, no private resume was read, and no tracked local database or `.env.local` file was added.

Baseline before changes:

- `npm test`: 40 files, 233 tests passed.

## TDD evidence

### 1. Text-mode clock and role transitions

RED:

- Microphone fallback entered text mode and the fixed clock callback was called 0 times after four seconds.
- Exhausted reconnect fallback also called the clock callback 0 times after entering text mode.

GREEN:

- Text mode stops realtime audio/question generation but keeps the interview clock running.
- Timed role changes update `lastRole` without sending websocket questions.
- A fixed test covers chair -> technical -> research -> English -> closing, and `sendText` uses the closing chair role and current elapsed time.
- Direct microphone fallback and exhausted reconnect fallback share the same clock restart behavior.

### 2. Realtime English follow-ups

RED:

- An English `follow_up` reused `questionText` and sent `Introduce your hometown briefly.` again.

GREEN:

- Only English `new_topic` controls use the exact selected bank question.
- English `follow_up` controls send a short non-technical follow-up instruction.
- The instruction explicitly forbids majors/courses, papers, projects, competitions, and technical details.

### 3. Coverage rebuild, exhaustion, ordering, and schema semantics

RED:

- Duplicate technical and English `new_topic` controls counted twice.
- Exhausted deterministic pools reused the first topic as another `new_topic`.
- Five invalid role/kind/depth combinations passed schema validation.
- Equal-`createdAt` controls loaded in insertion-dependent order.

GREEN:

- Coverage identity is unique by role and topic ID; English prefers `questionId` as its identity.
- Counts, used-topic lists, English question IDs, and categories use the deduplicated controls.
- Exhausted pools return a stable capped follow-up instead of falsely issuing an already-used new topic.
- `QuestionControlSchema` now enforces chair/closing, non-chair/non-closing, English new-topic question fields, new-topic depth zero, and follow-up depth 1 through 3.
- Stored controls order by `createdAt`, then `id`.

### 4. Persisted-but-undelivered realtime controls

RED:

- After `question_control` persistence succeeded and `response.create` threw, reconnect scheduled `communications` instead of resending the persisted `signals` control.
- The session route had no pending-control response and the schema rejected delivery events.

GREEN:

- Added validated `question_delivery` events containing only `controlId` and `deliveredAtMs`.
- Session reconstruction sorts events by `createdAt,id`, returns all controls, and returns the latest undelivered control as `pendingControl`.
- A later matching delivery event or interviewer transcript marks the control delivered.
- Reconnect/page reconstruction resends the same pending control without persisting a second coverage control, then persists delivery.
- Send failure or closed socket leaves the control pending for the next connection.

### 5. Technical/English text concurrency

RED:

- Two concurrent technical text requests returned `[200, 400]` and did not schedule against one latest coverage state.

GREEN:

- The existing durable research scheduling claim was generalized while keeping `research_initial_claim` compatibility.
- Technical and English use unique per-interview claim event types and a database partial unique index.
- Concurrent technical requests both return 200 and produce one new topic plus one follow-up.
- Duplicate English/technical controls cannot inflate coverage counts even if historical or retry data contains duplicates.

## Final verification

Focused affected suite:

- 8 files, 63 tests passed before final clock-branch coverage.
- Hook suite after the final clock branch: 2 files, 18 tests passed.

Fresh final verification on the final code state:

- `npm test`: 40 files, 251 tests passed.
- `npm run lint`: passed (`tsc --noEmit`).
- `npm run build`: passed.
- `npm run test:e2e`: 14 tests passed.
- `git diff --check`: passed.
- Diff scan found no API key, private resume path, test contact data, tracked `.env.local`, tracked `test_thing`, or tracked `data` addition.

Playwright emitted only the existing `NO_COLOR`/`FORCE_COLOR` environment warning.

## Residual considerations

- Delivery is intentionally at-least-once. If websocket send succeeds but persisting its delivery event fails before an interviewer transcript is saved, reconnect can conservatively resend the pending control. Once either delivery or transcript is persisted, it is not resent.
- Existing files produce Git LF-to-CRLF normalization notices on Windows; `git diff --check` reports no whitespace errors.
