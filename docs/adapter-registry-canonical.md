# Canonical Adapter Registry — Design

**Status:** Design. Implementation BLOCKED on P4 (loop consolidation). See "Dependency" below.
**Scope:** AUDIT Critical #2. Replaces two parallel provider-adapter registries with one canonical.
**Companion:** [AUDIT.md §1.3 Adapter Inventory](../AUDIT.md), [AUDIT-PLAN.md P2](../AUDIT-PLAN.md).

---

## Problem

Two adapter registries currently coexist:

| Registry | Location | Concrete adapters | Used by |
|---|---|---|---|
| **T1** — `getAdapter` function | `src/providers/index.ts` + per-provider files | `run-anthropic.ts`, `run-standard.ts`, `agent-codex/run-http.ts` | Legacy `runAgent` (cron, autopilot, sub-agents, workers, voice, delegation) |
| **T2** — `BaseAdapter` registry | `src/providers/adapter/{base-adapter,registry,types}.ts` + `src/providers/adapters/*` | `anthropic-http`, `anthropic-cli`, `codex-cli`, `openai-http`, `ollama-http` | Canonical-loop chat (`canonical-loop/`) |

T2 wraps T1 (the audit confirmed T2 adapters are "thin wrappers calling T1"). So the duplication isn't fundamental — it's a transitional artifact from the canonical-loop migration that didn't finish.

## Canonical choice: T2

T2 wins because:
1. Canonical-loop already depends on it. Migrating canonical to T1 would be moving backwards.
2. T2's `BaseAdapter` is a real interface with cancellation, lease semantics, and observation hooks. T1 is a function pointer with ad-hoc per-implementation behavior drift (per audit §1.3 "Cross-cutting inconsistencies").
3. Eval path (`replay-adapter.ts`) already plugs into T2 via `_override`.

T1 dies when the last legacy `runAgent` caller migrates to canonical (P4).

## Dependency: P2 ⊃ P4

P2 cannot execute its destructive steps (P2.C2 caller migration, P2.C3 deletion) until P4 (loop consolidation) finishes:

- Every legacy `runAgent` caller currently reaches T1 directly via `run-anthropic.ts` / `run-standard.ts` / `agent-codex/run-http.ts`.
- Migrating those callers to canonical-loop (P4.C3-C5) routes them through T2 instead.
- Once zero callers use T1, we can delete `run-anthropic.ts`, `run-standard.ts`, `agent-codex/run-http.ts` and the T1 wiring in `providers/index.ts` (this becomes part of P4.C6: "Delete legacy loops").

So P2's actual execution shrinks to:
- **P2.C1** (this doc): canonical choice + migration boundary
- **P2.C2** (post-P4): Audit that no T1 import sites remain. If clean, mark T1 deleted (already gone with the legacy loops).
- **P2.C3** (post-P4): Delete the `providers/adapter/` symlinks/types that only existed because T2 wraps T1. Consolidate the type tree into a single `providers/types.ts`.

## Cross-cutting inconsistencies to fix during migration

Per AUDIT §1.3 "Cross-cutting inconsistencies (should be uniform but aren't)":

1. Five adapters do five things slightly differently for `_localNoToolModels` (Critical #4 — flap state is module-level, never reset).
2. Codex `previousResponseId` is tracked in two competing stores (Critical #8 — `codex-session.ts` is dead after P0.C1; the other store is canonical).
3. Anthropic CLI proxy collapses message arrays (Critical #7 — fix during P5.C3).
4. Error classification differs between `model-fallback.classifyProviderError` and `provider-fallback.classifyProviderError` (Critical #5 — both die in P3.C3).

The migration is also the right moment to:
- Promote `_localNoToolModels` from module-level to per-adapter-instance state (Critical #4).
- Make every adapter expose the same cancellation contract (`adapter.abort()` should mean the same thing across all five).

## Implementation order (post-P4)

| Chunk | What | Risk |
|---|---|---|
| **P2.C2** | Audit T1 import sites. Expect 0 after P4.C6. If non-zero, file a new issue per remaining caller. | Low (read-only audit) |
| **P2.C3** | Delete `providers/index.ts` T1 wiring, consolidate adapter types into `src/providers/types.ts`. Update T2 imports to read from new location. | Medium (large diff but mechanical) |

If P4 produces clean migrations (every legacy caller routes through canonical), P2.C2 + P2.C3 collapse into a single "delete and tidy" chunk.

## Risks

- **R1.** P4 partial migration leaves a T1 caller behind → P2.C3 deletion breaks runtime. Mitigation: P2.C2 is a hard prerequisite gate. If grep finds ANY T1 import after P4, halt P2.
- **R2.** `replay-adapter.ts:64` mutates T2's `_override` for eval. Make sure the migration preserves the override hook — eval tests fail silently otherwise. Mitigation: smoke test `npm test eval` after P2.C3.
- **R3.** MCP-tool adapter wrapping (audit §1.2.4) doesn't go through either T1 or T2 — it's a separate code path. Confirm no overlap before deleting T1.
