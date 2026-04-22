# packages/arikernel/AGENTS.md — Hands off unless fixing a specific bug

This is the **vendored Ari Kernel** security layer. Originally a separate
open-source project (MIT), now absorbed into SAX as `file:` dependencies.

## Rules

- **Do not modify these packages to "improve" them casually.** Ari is the
  in-process security enforcement layer — every tool call routes through
  its policy engine + taint tracker. Changes here affect the safety of the
  whole system.
- **If a specific bug or gap requires a change here**, edit with care and
  only in scope of the bug. No refactors, no renames, no "while I'm here".
- **Don't add packages here.** `sidecar`, `adapters`, and `control-plane`
  were intentionally removed in commit 3278e5f because they existed only
  to support the now-deleted sidecar mode. Keep it lean — 6 packages total:
  `core`, `runtime`, `taint-tracker`, `policy-engine`, `audit-log`, `tool-executors`.
- **Build with `npm run build:ari`.** Triggered automatically by `npm run build`.
  Runs `tsup src/index.ts --format esm --dts` per package.
- **Don't upgrade to npm-hosted `@arikernel/*`.** We use local `file:` deps so
  the source lives inside this repo. Upstream npm packages may be stale or
  removed.

## Integration point

`src/ari-kernel.ts` is the SAX-side wrapper. It imports `@arikernel/runtime`
and calls `createKernel({ mode: "embedded" })` once at startup, then exposes
`ariEvaluate()` / `isAriActive()` for the tool executor. If you need to change
Ari's behavior, check whether the fix belongs in:

1. **The wrapper** (`src/ari-kernel.ts`) — mapping SAX tool names to Ari tool classes, fail-open vs fail-closed decisions, preset selection.
2. **The kernel** (this directory) — actual policy rules, taint rules, engine logic.

Start with #1. Only change #2 if the problem is fundamentally in the kernel.
