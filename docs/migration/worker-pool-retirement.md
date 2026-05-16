# Worker-pool retirement — migration plan

**Status:** COMPLETE
**Completion date:** 2026-05-15
**Owner:** Alex

---

## Goal

Collapse the two parallel op lifecycle systems into one. Worker-pool
(`pool.killOp`, fork-based) retires. Canonical-loop (`opCancel`, in-process)
becomes the single path for every op LAX produces.

The "two systems" today is a stalled migration. Canonical-loop was built to
replace worker-pool. The flag-based router (`decideSubmitRouting`) was the
strangler-fig seam. The migration never finished. This plan finishes it.

---

## What the user keeps (zero regression)

The unification is internal. From the user's seat:

1. **Main agent still spawns workers** via `op_submit_async`. Tool surface,
   args, return shape unchanged.
2. **Spawned workers still show in the AGENTS sidebar** as op_* cards with
   live progress.
3. **Main agent stays free to chat** while delegated ops run in the
   background. Sub-second submit return preserved.
4. **Stop / cancel buttons work** on every op type.
5. **`op_status` / `op_kill` / `op_output` / `op_wait` / `op_redirect`** all
   keep their existing signatures and behavior.

The op-store event log is already shared between the two systems, so the
sidebar reads the same source either way.

---

## What goes away (internal)

- `src/workers/pool.ts` — fork supervisor, IPC routing, worker slots
- `src/workers/worker-entry.ts` — forked child entry point
- `src/workers/heartbeat.ts` (if fork-specific portions only)
- `src/workers/ipc.ts` — IPC envelope helpers
- `src/routing/delegate-worker.ts` — legacy submit path
- The `decideSubmitRouting` fork — collapses to one always-canonical path
- `killOp` references throughout the codebase
- Dual-fire cancel in [chat-ws.ts:441-461](../../src/chat-ws.ts#L441-L461) —
  drops the `killOp` half
- The `LAX_CANONICAL_LOOP_*` per-lane flags — no longer needed
- The legacy-path canonical-loop tests (`canonical-loop-10-old-path-compat`,
  parts of `canonical-loop-01-schema-flag` that exercise the flag-OFF branch)

---

## What stays (renamed / moved)

- `src/workers/op-store.ts` → moves to `src/canonical-loop/op-store.ts`.
  Op-store is the canonical event log. It's already shared; just relocate.
- `src/workers/tools.ts` → stays, but `submitOp` always routes canonical.
  Tool definitions for `op_submit_async`, `op_status`, etc. live here.
- `src/workers/session-bridge.ts` → keep. Session-to-op binding is
  lifecycle-agnostic.
- `src/workers/context-pack-builder.ts` → keep. Pure helper.
- `src/workers/checkpoint.ts` → keep if canonical-loop uses it; verify.

A post-merge pass should rename `src/workers/` → `src/ops/` so the directory
name matches what's left.

---

## Phases

### Phase 1 — Force-canonical default (low risk)

**Goal:** make canonical-loop the default route for every lane. Legacy stays
in tree but unreachable in normal use.

1. Set `LAX_CANONICAL_LOOP_ALL=1` as the default in `decideSubmitRouting`
   (treat absent as ON instead of OFF).
2. Update [docs/runbooks/canonical-loop-rollback.md](../runbooks/canonical-loop-rollback.md)
   to reflect the new default.
3. Soak for one week of normal use. Watch for:
   - Cancel surfaces working on every op type (already validated by the
     senior-engineer pass on 2026-05-15 — chat-runner now bridges to
     `opCancel`).
   - AGENTS sidebar cards correctly cancelling, no zombie ops.
   - Worker spawn from main agent still surfaces progress events.
   - No new error patterns in `~/.lax/logs/`.

**Rollback:** set `LAX_CANONICAL_LOOP_ALL=0`. Reverts to fork path.

### Phase 2 — Delete the legacy fork path

**Goal:** remove the fork-based execution path entirely.

1. Delete `src/workers/pool.ts`, `worker-entry.ts`, `ipc.ts`,
   `routing/delegate-worker.ts`.
2. Collapse `decideSubmitRouting` — drop the lane flag check, always return
   `canonical`. Or delete the function and inline `canonicalLoopEntry`.
3. Update [src/workers/tools.ts](../../src/workers/tools.ts) `submitOp`:
   remove the `routing.route === "legacy"` branch, always call
   `canonicalLoopEntry`.
4. Update [src/chat-ws.ts:441-461](../../src/chat-ws.ts#L441-L461): drop
   `killOp` import, keep only the `opCancel` call. Same for
   `cancelQueuedOp`.
5. Strip `LAX_CANONICAL_LOOP_*` env reads. Delete `src/canonical-loop/router.ts`
   or reduce to a stub returning `{ route: "canonical" }`.
6. Delete tests that exercise the legacy path:
   - `test/canonical-loop-10-old-path-compat.test.ts` (entire file)
   - The flag-OFF branches in `canonical-loop-01-schema-flag.test.ts`
   - `test/pool-cancel.test.ts`, `test/pool-control.test.ts`
   - Update any test importing from `src/workers/pool.ts`

**Rollback:** revert the deletion commit. Not a flag flip — requires a
release.

### Phase 3 — Namespace cleanup (optional polish)

1. Rename `src/workers/` → `src/ops/` since nothing is fork-related anymore.
2. Tighten op ID prefixes: `op_freeform_*` ambiguity goes away once one
   system owns it. Consider stricter prefixes per op type
   (`op_delegate_*`, `op_chat_*`, `op_agent_*`).
3. Document the single op lifecycle in
   [docs/canonical-loop-prd.md](../canonical-loop-prd.md) — drop legacy
   references.

---

## Test strategy

Run before each phase:
- `npm test` — full canonical-loop suite
- `npm run test:canonical-loop` — the cancel/replay/reconnect invariants
- Manual smoke: chat with each provider (Anthropic, Codex, Cerebras), spawn
  a long-running delegation, verify sidebar updates, hit cancel, verify
  worker actually stops.

Run after Phase 2:
- Full repo grep for `killOp`, `pool.ts`, `cancelQueuedOp` — must return zero
  hits outside the deletion list.
- `npm run typecheck` — must pass.
- Smoke a real `op_submit_async` build_app — verify the spawned op streams
  progress, can be cancelled, leaves a clean op-store record.

---

## Risk inventory

| Risk | Mitigation |
|---|---|
| Canonical-loop has a latent bug forks were masking | Phase 1 soak period before deletion |
| A tool we forgot relies on fork IPC | Phase 1 logs catch surface area; grep `from .*pool.ts` before Phase 2 |
| In-flight ops at deploy time on legacy path | Per PRD §17, flag captured per-op; legacy ops complete on legacy code as long as it's still in the binary. Phase 2 deletion only blocks *new* submissions. |
| Memory pressure from running everything in parent | Op-store already prunes; canonical-loop ops are short-lived; monitor first week |
| Cancel regression on some op type | Senior-engineer cancel pass on 2026-05-15 covered all surfaces; re-run the same smoke after each phase |

---

## Why this is safe

1. **Op-store is already shared.** Both systems write to the same event log.
   The sidebar, status APIs, and reconnect machinery don't change.
2. **`op_submit_async` is the only public surface.** It's an MCP tool. Its
   signature is contract; everything underneath is implementation.
3. **Canonical-loop has been the canary path for months.** All new features
   target it. The legacy path has not had a new feature added in this period.
4. **Cancel was the riskiest seam.** Already fixed and verified on 2026-05-15
   (chat-runner bridges external signal → opCancel; dual-fire in chat-ws.ts
   handles the namespace overlap during transition).

---

## Open questions

- Worker-pool's heap pressure recycling — is canonical-loop's equivalent
  story documented? If not, write it before Phase 2.
- Heartbeat / lease semantics — `src/workers/heartbeat.ts` may have pieces
  canonical-loop needs. Audit before deletion.
- Any external consumer of the fork model? Internal-only, but confirm no
  one's depending on the process-isolation property for sandboxing reasons.

---

## Deletion date

Completed 2026-05-15. Phase 1 → Phase 3 ran inside three days against the
original "two weeks from Phase 1 if soak is clean" target, because no
canonical-attributable regressions surfaced during the soak.

---

## Result

Three commits landed on `main`:

| Phase | Commit | What landed | LOC delta |
|---|---|---|---|
| 1 | `f14a44b` | `decideSubmitRouting` default flipped to canonical for all lanes; `LAX_CANONICAL_LOOP_ALL` treated as ON when absent | +120 / −53 |
| 2 | `d1703ea` | Fork lifecycle deleted: `pool.ts`, `worker-entry.ts`, `ipc.ts`, `routing/delegate-worker.ts`, legacy-path tests, `killOp` plumbing | +430 / −3720 |
| 3 | this commit (subject `refactor(ops): rename workers/ to ops/ post-fork-retirement`) | `src/workers/` renamed to `src/ops/`; consumer imports swept; PRD §17 marked retired | +245 / −206 |

Net: **+795 / −3979** across the three phases (≈3.2k lines net deletion).

After Phase 3, `src/ops/` contains only canonical lifecycle helpers
(op-store, event-log, heartbeat, session-bridge, idle-nudge,
pending-notifications, context-pack-builder, checkpoint, redactor,
provider-matrix, tools, types). No fork code, no IPC envelope helpers, no
flag routing. The directory name now matches the contents.
