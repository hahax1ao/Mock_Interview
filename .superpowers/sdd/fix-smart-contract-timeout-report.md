# Material extraction smart-contract and timeout fix

## Scope

Fix material extraction without changing the global timeout used by realtime or review requests. No real API call was made during this task; all automated tests are network-free, and the controller owns the follow-up real acceptance test.

## Root cause

Two independent boundaries failed in the authorized isolated DashScope acceptance test:

1. With the default 60-second client timeout, both upload and retry timed out at exactly 60 seconds.
2. With a temporary `QWEN_REQUEST_TIMEOUT_MS=120000`, DashScope responded after more than 60 seconds, but produced root keys `项目经历` / `科研经历` / `竞赛经历` / `技能` / `荣誉` instead of the required `facts` root. The strict Zod schema then rejected `facts: undefined` and the unrecognized keys.

The code matched this evidence: `qwenJson` only exposed the singleton client's global timeout, while the material prompt described fields but did not explicitly prescribe the sole root-object shape.

## RED

Added regression coverage before production changes:

- `material-smart-extraction.test.ts` requires invoke options to contain the exact contract `{"facts":[{"field":"...","value":"...","evidence":"...","page":1,"confidence":0.8}]}` and `timeoutMs: 120000`.
- `qwen.test.ts` requires the per-call timeout to reach the second `chat.completions.create` request-options argument as `{ timeout: 120000 }`.

Focused RED command:

`npm test -- --run src/lib/material-smart-extraction.test.ts src/lib/qwen.test.ts`

Observed result: 2 failed, 17 passed. The failures showed the contract text was absent and the OpenAI request-options argument was `undefined`.

## GREEN

Minimal implementation:

- Added optional `timeoutMs` to `qwenJson` and passed it only as per-call OpenAI request options.
- Added the exact, exclusive `facts` root shape to the material extraction system prompt.
- Set only material extraction to `timeoutMs: 120000`; the global 60-second default and review/realtime call sites remain unchanged.

Verification evidence:

- Focused: 2 test files passed, 19 tests passed.
- Full suite: 24 test files passed, 82 tests passed.
- Lint/type-check: `npm run lint` exited successfully with no diagnostics.

## Real acceptance evidence and remaining check

The supplied real evidence establishes both original failure modes: exact 60-second timeouts under defaults, then a post-60-second response with the wrong root shape under a temporary 120-second global timeout. This change addresses those modes at the material call boundary.
