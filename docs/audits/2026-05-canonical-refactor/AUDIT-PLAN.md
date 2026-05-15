# Audit Refactor — Execution Plan

**Operating model.** Claude Code (parent session) orchestrates. Each chunk runs in a **fresh Claude Code session** that Alex spawns by pasting the chunk briefing (below). The fresh session inherits no context — the briefing is self-contained. After each chunk, parent session reviews the diff, runs the smoke test, and commits.

**Spec-truth for this refactor.** The existing test suite + a one-prompt chat smoke test per chunk. No held-out scenarios (this is a refactor, not greenfield).

**Behavior contract.** Every chunk MUST preserve observable behavior unless the chunk briefing explicitly says "this chunk removes feature X." Test diffs other than additions require explicit justification in the report's NOTE field.

**Chunk discipline (inherited from /senior-engineer):**
- Smallest correct change. No drive-by refactors.
- Read before editing. Match existing style.
- One commit per chunk. Atomic revert is the safety net.
- If a deletion / migration spans more than ~5 files, split into multiple chunks.

**Report format every chunk returns** (parent session uses this to gate the next chunk):

```
STATUS: done | blocked | partial
CHANGED: <comma-separated paths>
TESTS: <pass>/<total> | n/a
NEW_FAILURES: <test names introduced, or none>
PRE_EXISTING_FAILURES: <test names that already failed, or none>
BEHAVIOR_RISKS: <observable behavior changes the chunk introduces, or none>
ROLLBACK: <one-line "git revert <sha>" or "git reset --hard HEAD~1" — confirm reversible>
NOTE: <anything the parent needs to know>
```

---

## Phases (risk-ordered)

| Phase | Theme | Risk | Chunks |
|---|---|---|---|
| **P0** | Dead-code sweep | Near-zero | 2 |
| **P1** | Cluster 11 (tool filtering) | Low | 4 |
| **P2** | Adapter registry unification | Medium | 3 |
| **P3** | Retry layer consolidation | Medium | 3 |
| **P4** | Loop consolidation (legacy → canonical) | High | 6 |
| **P5** | Cross-cutting Criticals (#3, #4, #7, #10) | Variable | 4 |

Phase-gates between each phase: parent runs full test suite + a real chat smoke test + browses for visible regressions before approving next phase.

---

## P0 — Dead-code sweep (warmup, proves the loop)

### P0.C1 — Delete confirmed-dead files (§2.6.A1 + A2)

**Skill:** `/senior-engineer`
**In scope:**
- §2.6.A1 (8 single-line stubs): `bookkeeping-tools.ts`, `cloud-storage-tools.ts`, `contacts-tools.ts`, `crm-tools.ts`, `ecommerce-tools.ts`, `notification-tools.ts`, `payment-tools.ts`, `sms-tools.ts`
- §2.6.A2 (11 confirmed-dead): `anthropic-client/stream-oauth.ts`, `batch-embeddings.ts`, `codex-session.ts`, `codex-payload-policy.ts`, `classifiers/vision-entity-extract.ts`, `security-rbac.ts`, `smart-compaction.ts`, `tool-interface.ts`, `voice-tools.ts`, `voice/voice-llm.ts`, `workers/dag-templates.ts`

**Out of scope:** A3 "suspected dead" cluster (needs runtime verification, separate chunk).

**Done-when:**
- All 19 files deleted.
- `tsc --noEmit` clean.
- `git grep` for each deleted filename's basename returns zero results (excluding AUDIT.md references).
- Server boots successfully (run `npm run dev:nowatch`, wait for `listening on 7007`, kill).

**Behavior contract:** Zero observable behavior change. These files have zero call sites by audit verification.

**Smoke test:**
1. `node node_modules/typescript/bin/tsc --noEmit` → expect clean.
2. Start server, hit `GET /api/health`, expect 200.

**Commit:** `chore: delete 19 confirmed-dead files (AUDIT §2.6.A1+A2)`

---

### P0.C2 — Strip 82 unused imports/locals (§2.6.C)

**Skill:** `/senior-engineer`
**In scope:** Run `tsc --noEmit --noUnusedLocals`, remove every flagged import/local that ISN'T re-exported and ISN'T tagged `@public`. Specifically named in audit:
- `session-export.ts:1-2` (3 imports)
- `camera-tool.ts:6-7` (2)
- `document-tools.ts:1,16` (2)
- `memory-importance.ts:17,220,336`
- `routes/chat.ts:6,8,129` (4)
- `agent-codex/run-http.ts:11,83`
- `providers/run-standard.ts:87`
- `tool-executor.ts:61,68,75` (3 type aliases)
- `hot-reload.ts:14`
- The remaining ~60 flagged by the compiler.

**Out of scope:** Anything `--noUnusedParameters` flags. Anything outside `src/`.

**Done-when:**
- `tsc --noEmit --noUnusedLocals` → zero diagnostics.
- Standard `tsc --noEmit` → clean.

**Behavior contract:** Zero observable behavior change.

**Smoke test:** Same as P0.C1.

**Commit:** `chore: remove 82 unused imports/locals (AUDIT §2.6.C)`

---

## P1 — Cluster 11: Tool filter consolidation

### P1.C1 — Design the canonical tool resolver (research-only, no code changes)

**Skill:** `/senior-engineer`
**In scope:** Produce `docs/tool-resolver-design.md` (or extend AUDIT.md Cluster 11). Specify:
1. The `Audience` type: `"main-chat" | "spawned-agent" | "operator" | "build-intent"`.
2. New `ToolDefinition` fields: `audiences: Audience[]`, `requiresWorktree?: boolean`.
3. New `resolveToolsForRequest({ audience, message }, registry): ToolDefinition[]` signature + behavior.
4. Migration mapping for each of the five current filter sets → which audience(s).
5. Backward-compat shim plan: how to keep `filterToolsForMessage` working during migration.

**Done-when:** Design doc exists, names every current caller, has a concrete migration order for P1.C2/C3/C4.

**Behavior contract:** Documentation only. No code changes.

**Smoke test:** Doc is self-consistent and references real file paths.

**Commit:** `docs: design canonical tool-resolver (AUDIT Cluster 11)`

---

### P1.C2 — Add `audiences` to `ToolDefinition` + tag all tools (additive only)

**Skill:** `/senior-engineer`
**In scope:**
- Add optional `audiences?: Audience[]` and `requiresWorktree?: boolean` to `ToolDefinition` in [src/types.ts](src/types.ts).
- Tag every tool in `allTools` ([src/tools/registry-build.ts](src/tools/registry-build.ts)) and the dynamically-built tools in [src/server/bootstrap-tools.ts](src/server/bootstrap-tools.ts) with the right audience(s).
- Implement `resolveToolsForRequest` per P1.C1's design — co-located with `ToolRegistry` in [src/tool-search.ts](src/tool-search.ts).
- **Do NOT change any callers yet.** Existing filters continue to work; this chunk only adds the new surface.

**Out of scope:** Migration of `filterToolsForMessage`, handler-events, or any caller. That's P1.C3.

**Done-when:**
- `ToolDefinition.audiences` is set on every tool in `allTools`.
- `resolveToolsForRequest("main-chat", "") → length === CORE_TOOL_NAMES.size + primal_* tools` (we keep the additions made in commit 4182223).
- `tsc --noEmit` clean.
- Existing tests pass.

**Behavior contract:** Zero observable behavior change. New code path exists but is not called.

**Smoke test:** Real chat turn ("what's 2+2?") works; provider receives same tool count as before.

**Commit:** `feat(tools): add audiences field + resolveToolsForRequest (canonical resolver)`

---

### P1.C3 — Migrate `filterToolsForMessage` callers to `resolveToolsForRequest`

**Skill:** `/senior-engineer`
**In scope:**
- Replace all calls to `filterToolsForMessage(allTools, message)` with `resolveToolsForRequest({ audience: "main-chat", message }, registry)`.
- Keep `filterToolsForMessage` exported as a thin shim that delegates to the new function (so any external caller / test still works).
- Verify the substitution produces the **same tool list** for the same input. If not, fix the audience tags from P1.C2.

**Out of scope:** Spawned-agent migration (handler-events.ts). That's P1.C4.

**Done-when:**
- Every chat path uses `resolveToolsForRequest`.
- Diff between old and new tool list for 10 representative messages: empty.
- `tsc --noEmit` clean.

**Behavior contract:** Tool list passed to provider must be byte-identical to pre-change for at least these 10 messages:
1. `"hi"`
2. `"what's 2+2"`
3. `"build me an app"` (build-intent path)
4. `"send an email"` (keyword path)
5. `"primal_run_build_plan({...})"` (literal-call path)
6. `"open my spreadsheet"`
7. `"pin this to sidebar"`
8. `"check my calendar"`
9. `"what's the weather"`
10. `"refactor this function"`

**Smoke test:**
1. Real chat: `"primal_run_build_plan({project_dir: \"mygroomtime\", starting_chunk: 6, max_chunks: 1})"` — expect direct tool call, no tool_search, no self_edit.
2. Real chat: `"build me a todo app"` — expect build-intent strip-down.

**Commit:** `refactor(tools): migrate chat tool-filter to canonical resolver`

---

### P1.C4 — Migrate spawned-agent filters + kill the `isCodeRole` regex

**Skill:** `/senior-engineer`
**In scope:**
- Replace `OPERATOR_TOOLS` / `CORE_AGENT_TOOLS` lookups in [src/server/handler-events.ts:77-101](src/server/handler-events.ts#L77) with `resolveToolsForRequest({ audience: agentDef.audience, ... })`.
- Add `requiresWorktree: boolean` to the AgentDefinition / SpawnConfig surface so callers pass it explicitly. The chunk-runner agent definition sets `requiresWorktree: false` (we want the worker to run in the project dir, not a LAX worktree). The legacy "coder" definitions that DO want a worktree (if any) set `requiresWorktree: true`.
- **Delete** the `isCodeRole` regex at [handler-events.ts:107](src/server/handler-events.ts#L107). Worktree creation is now keyed off the explicit field.
- Revert the chunk-runner role workaround: role goes back to `"coder"` (or stays `"implementer"`, doesn't matter — role string is no longer behavior-bearing for worktree decisions).
- Delete the now-orphan `EAGER_TOOLS` set in [src/tools/registry-build.ts](src/tools/registry-build.ts) (or document why it stays).

**Done-when:**
- `isCodeRole` regex gone.
- `OPERATOR_TOOLS` / `CORE_AGENT_TOOLS` deleted.
- `EAGER_TOOLS` either deleted or its role formally documented.
- Spawn a chunk-runner agent; verify it runs in the project dir, NOT a LAX-repo worktree (check `bash pwd` output in agent log).
- `tsc --noEmit` clean.

**Behavior contract:** Spawned-agent tool list is identical to pre-change for these agents: chunk-runner-trunk, chunk-runner-leaf, scenario-fix, builtin-researcher, builtin-coder.

**Smoke test:**
1. Run `primal_run_build_plan({project_dir: "mygroomtime", starting_chunk: 6, max_chunks: 1})`.
2. Watch chunk-runner agent's first bash call: expected pwd is the mygroomtime workspace, NOT a worktree.
3. Verify no regression in non-chunk-runner spawned agents — spawn a researcher and confirm it gets the right tool list.

**Commit:** `refactor(tools): unify spawned-agent filters + kill isCodeRole regex`

---

## P2 — Adapter registry unification (Critical #2)

> Audit says: T1 (`getAdapter` via `providers/`) and T2 (`BaseAdapter` registry in `providers/adapter/`) are two parallel registries. Five concrete adapters in T2, parallel to T1 wrappers.

### P2.C1 — Document the canonical registry choice (research-only)

**Skill:** `/senior-engineer`
**In scope:** Decide T1 or T2 is canonical (audit suggests T2 since canonical-loop uses it). Produce `docs/adapter-registry-canonical.md` naming every T1 caller and the migration path.

**Done-when:** Doc enumerates all T1 callers (use Grep), names the canonical, has migration order.

**Commit:** `docs: pick canonical adapter registry (AUDIT Critical #2)`

---

### P2.C2 — Migrate T1 callers to T2

**Skill:** `/senior-engineer`
**In scope:** Per the design from P2.C1, migrate each T1 caller to T2. One commit per ~3 callers; if more, split the chunk.

**Done-when:** Zero T1 imports remain. All chat + non-chat paths verified working.

**Commit:** `refactor(providers): migrate T1 callers to canonical adapter registry`

---

### P2.C3 — Delete the dead registry

**Skill:** `/senior-engineer`
**In scope:** Delete the now-orphan registry files. `tsc` clean. Server boots.

**Commit:** `chore: delete dead adapter registry (AUDIT Critical #2)`

---

## P3 — Retry layer consolidation (Critical #5)

### P3.C1 — Inventory + design canonical retry

**Skill:** `/senior-engineer`
**In scope:** Document each of the 4-6 retry layers (`tool-executor.withRetry`, per-loop stream-error handlers, `routes/chat.ts:525-580` cascade, `model-fallback.withFallback`, `provider-fallback.ProviderChain`, warm-pool subprocess retry). Pick one canonical strategy with a shared budget + correlation key.

**Commit:** `docs: design canonical retry strategy (AUDIT Critical #5)`

---

### P3.C2 — Implement canonical retry + migrate callers

**Skill:** `/senior-engineer`
**Behavior contract:** Retry behavior is **equivalent or strictly safer** for the user-visible cases. Easy regression: too-aggressive retry on 4xx (don't), or no retry on 503/timeout (do).

**Commit:** `refactor(retry): unify retry layers with shared budget + correlationId`

---

### P3.C3 — Delete dead retry orchestrators

**Skill:** `/senior-engineer`
**In scope:** `src/model-fallback.ts` (~266 LOC, unused), `src/provider-fallback.ts` (~183 LOC, unused except for `getProviderHealthStatus` — keep that export only).

**Commit:** `chore: delete dead retry orchestrators (AUDIT Critical #5)`

---

## P4 — Loop consolidation (Critical #1)

> Audit: three live agent-turn loops (canonical, gated unified, legacy per-provider). Chat uses canonical; everything else still uses legacy via `runAgent`. This is the biggest refactor — split aggressively.

### P4.C1 — Inventory non-chat `runAgent` callers

**Skill:** `/senior-engineer`
**In scope:** Document each caller class (cron, autopilot, sub-agents, workers, voice, delegation-handoff), what tools/audiences they need, what middlewares the canonical loop is missing for them.

**Commit:** `docs: inventory non-chat runAgent callers (AUDIT Critical #1)`

---

### P4.C2 — Port missing middlewares to canonical-loop

**Skill:** `/senior-engineer`
**In scope:** Per audit Critical #2: loop-detection, dead-end nudge, post-commit nudge, hallucination check, action-claim check, self-check, mid-turn-evidence-stale, force-tool-use, post-turn-detector, auto-route-build-app. Port each to a canonical-loop middleware. Test against canonical chat — no behavior change for chat.

**Commit:** `feat(canonical-loop): port legacy safety middlewares`

---

### P4.C3 — Migrate cron + autopilot callers

**Skill:** `/senior-engineer`

**Commit:** `refactor(canonical-loop): migrate cron + autopilot to canonical path`

---

### P4.C4 — Migrate sub-agent + worker callers

**Skill:** `/senior-engineer`

**Commit:** `refactor(canonical-loop): migrate sub-agent + worker spawn to canonical`

---

### P4.C5 — Migrate voice + delegation-handoff

**Skill:** `/senior-engineer`
**Behavior contract:** Voice latency must not regress measurably (per audit R3).

**Commit:** `refactor(canonical-loop): migrate voice + delegation to canonical`

---

### P4.C6 — Delete legacy loops

**Skill:** `/senior-engineer`
**In scope:** `src/providers/run-standard.ts`, `src/providers/run-anthropic.ts`, `src/agent-codex/run-http.ts`, `src/agent-loop/run.ts` (the gated unified loop). The `LAX_UNIFIED_LOOP` flag is now dead — remove.

**Commit:** `chore: delete legacy agent-turn loops (AUDIT Critical #1)`

---

## P5 — Cross-cutting Criticals

### P5.C1 — Fix two-writer drift on `session.messages` (Critical #3)

**Skill:** `/senior-engineer`
**In scope:** [src/routes/chat.ts:287-433](src/routes/chat.ts#L287). One writer wins. Delete the snapshot-and-revert hack.

---

### P5.C2 — Scope `_localNoToolModels` (Critical #4)

**Skill:** `/senior-engineer`
**In scope:** Make `_localNoToolModels` per-adapter-instance instead of module-level. Or reset on provider switch. Document if a flap should persist across requests (probably no).

---

### P5.C3 — Anthropic CLI prompt-build dedup (Critical #7)

**Skill:** `/senior-engineer`
**In scope:** Merge the warm-pool ([stream-cli.ts:111-143](src/anthropic-client/stream-cli.ts#L111)) and cold-spawn ([:173-252](src/anthropic-client/stream-cli.ts#L173)) prompt-building paths into one helper.

---

### P5.C4 — WS chat self-loop via HTTP (Critical #10)

**Skill:** `/senior-engineer`
**In scope:** [src/server/lifecycle.ts:287](src/server/lifecycle.ts#L287). Replace HTTP self-loop with direct canonical-op subscription. Lower latency, simpler stack.

---

## Per-chunk briefing template (for fresh-session paste)

```
You are a fresh Claude Code session executing one chunk of the LAX audit refactor.

Skill: /senior-engineer
Chunk: <P_C_>
Title: <chunk title>

Read these first (load context):
- AUDIT-PLAN.md (this file) — section for this chunk
- AUDIT.md — referenced section(s)
- <any other context files named in the chunk>

Then execute the chunk. The parent session will:
1. Review the diff before commit.
2. Run the smoke test you specify.
3. Commit on green.

DO NOT:
- Do work outside the chunk's "In scope" list.
- Add error handling for scenarios that can't happen.
- Refactor neighboring code that "could be improved."
- Mark tests as skipped to make CI pass.

Report at the end in the exact format documented in AUDIT-PLAN.md "Report format every chunk returns".
```

---

## Risks and known unknowns

- **R-audit-1:** AUDIT.md's "A3 cluster" (~30 files imported only by `test-suite.ts`) is NOT in this plan — needs a separate runtime-verification chunk before deletion. Add as `P0.C3` if test-suite.ts itself turns out to be dead.
- **R-audit-2:** The audit's Phase 1 entry-point map was machine-traced — if a Steps 1-11 reference in the audit doesn't appear here, it's because I prioritized the Critical #1-10 issues. Re-read audit Phase 3 for anything missing.
- **R-execution-1:** Fresh-session chunks lack conversation history. If a chunk needs prior decisions, those MUST be written into a `.md` file the chunk can read (not just spoken to me in chat).
- **R-execution-2:** The 5s push-on-state-change debouncer ships every chunk's commit to remote within ~5s. If we want chunks to be reviewable BEFORE remote, disable sync during this refactor or batch-push at phase-gates.
