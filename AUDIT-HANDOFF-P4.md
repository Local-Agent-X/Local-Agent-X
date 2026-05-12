# P4 Handoff Briefings — Fresh Sessions

**State on handoff:**
- P0 done. ~2068 LOC removed (dead files + unused imports).
- P1 (Cluster 11) done. Five tool filters collapsed to one canonical resolver. `isCodeRole` regex deleted. Parity tests green.
- P2.C1 doc done. Adapter migration BLOCKED on P4.
- P3.C1 doc done. Retry migration BLOCKED on P4.
- P3.C3 done. ~266 LOC of dead retry orchestrators removed.

**What's left, in order:**
- **P4.C1** — Inventory non-chat `runAgent` callers (research + doc, no code)
- **P4.C2** — Port legacy safety middlewares to canonical-loop (additive only)
- **P4.C3** — Migrate cron + autopilot callers to canonical
- **P4.C4** — Migrate sub-agent + worker callers to canonical
- **P4.C5** — Migrate voice + delegation-handoff callers to canonical
- **P4.C6** — Delete legacy loops (run-anthropic.ts, run-standard.ts, agent-codex/run-http.ts, agent-loop/run.ts)
- **P2.C2 + P2.C3** — Delete dead adapter registry T1 after P4 (small mop-up chunks)
- **P3.C2** — Wire RetryContext into the remaining 3 retry layers after P4
- **P5.C1-C4** — Cross-cutting Criticals (two-writer drift, _localNoToolModels scope, anthropic-cli prompt-build dedup, WS chat HTTP self-loop)

**Why fresh sessions for P4:** these chunks are big, high-risk, and benefit from independent review. The parent session has been holding the design context; fresh sessions get the briefing + audit + the relevant code paths and execute without inherited assumptions.

---

## Handoff workflow

For each chunk below:
1. Copy the briefing block into a new Claude Code session.
2. Wait for the report block back.
3. Review the diff, run the smoke test, commit + push.
4. Then paste the next chunk.

Each briefing is self-contained — the fresh session reads AUDIT.md + AUDIT-PLAN.md + AUDIT-HANDOFF-P4.md + the specific code paths, no inherited context required.

---

## P4.C1 — Inventory non-chat `runAgent` callers (RESEARCH ONLY)

```
You are a fresh Claude Code session executing one chunk of the LAX audit refactor.

Skill: /senior-engineer
Chunk: P4.C1
Title: Inventory non-chat runAgent callers (research only)

## Context
LAX has THREE live agent-turn loops (per AUDIT.md Critical #1):
- Canonical loop (src/canonical-loop/) — used by chat traffic
- Gated unified loop (src/agent-loop/run.ts, env LAX_UNIFIED_LOOP=1) — barely used
- Legacy per-provider loops (src/providers/run-anthropic.ts, src/providers/run-standard.ts, src/agent-codex/run-http.ts) — used by `runAgent` for EVERYTHING non-chat

The legacy loops differ from canonical in:
- Different idle/wall-clock timeouts (180s vs 600s)
- Different middleware coverage (loop-detection, dead-end nudge, hallucination check, etc — all listed in AUDIT.md Critical #2)
- No replay/reconnect semantics

P4 migrates every non-chat caller to canonical. This chunk inventories WHICH callers exist so the migration chunks (P4.C3/C4/C5) have a complete worklist.

## In scope (RESEARCH ONLY — NO CODE CHANGES)
1. Find every call site of `runAgent` (the legacy function in src/agent.ts). Use git grep.
2. For each caller, classify into a bucket: cron / autopilot / sub-agent (handler-events spawn) / worker-pool / voice / delegation-handoff / other.
3. For each caller, record:
   - file:line of the call
   - what triggers it (cron schedule, user message, agent_spawn, etc)
   - which provider it uses (anthropic, codex, openai/xai/gemini/local)
   - what middlewares the legacy loop runs that canonical-loop does NOT (cross-reference AUDIT.md §1.2.1 vs §1.2.2)
   - whether the caller already has replay/reconnect (likely no)

Produce a new file: `docs/runagent-caller-inventory.md` with the table.

## Out of scope
- ANY code changes. Pure research.
- Identifying middlewares to port — that's P4.C2.
- Designing the per-caller migration strategy — that's the next chunks' job.

## Done-when
1. `docs/runagent-caller-inventory.md` exists.
2. Every `runAgent(` call site in `src/` is listed.
3. Each caller is bucketed into one of: cron / autopilot / sub-agent / worker-pool / voice / delegation-handoff / other.
4. Cross-reference column lists which legacy middlewares each caller relies on (per AUDIT.md Critical #2 list).

## Smoke test
1. `git grep -nE "\\brunAgent\\(" src/ | wc -l` — confirm the inventory line count matches (or note legitimate exclusions like comments).
2. `node node_modules/typescript/bin/tsc --noEmit` — clean (no code changed).

## Commit
`docs: inventory non-chat runAgent callers (AUDIT Critical #1, P4.C1)`

Do NOT push — parent reviews then pushes.

## Report
STATUS / CHANGED / TESTS (n/a) / NEW_FAILURES / PRE_EXISTING_FAILURES (n/a) / BEHAVIOR_RISKS (none) / ROLLBACK (delete the new doc file) / NOTE
```

---

## P4.C2 — Port legacy safety middlewares to canonical-loop (ADDITIVE)

```
You are a fresh Claude Code session executing one chunk of the LAX audit refactor.

Skill: /senior-engineer
Chunk: P4.C2
Title: Port legacy safety middlewares to canonical-loop (additive only)

## Context
AUDIT.md Critical #2:
> "Canonical chat silently no-ops large parts of the legacy safety stack.
>  Loop-detection, dead-end nudge, post-commit nudge, hallucination check,
>  action-claim check, self-check, mid-turn-evidence-stale, force-tool-use,
>  post-turn-detector, and auto-route-build-app — all exist as middlewares
>  in src/agent-loop/middlewares/ and inline in the legacy loops, but
>  none run on the canonical chat path. This is a behavior gap, not just
>  a code smell."

Before we migrate non-chat callers from legacy → canonical (P4.C3-C5),
canonical needs to grow these middlewares. Otherwise migrating cron /
autopilot to canonical strips safety nets they rely on.

P4.C1's inventory tells us which callers depend on which middlewares.
Read it before starting.

## In scope
1. Read `docs/runagent-caller-inventory.md` (from P4.C1).
2. Read `src/agent-loop/middlewares/` to understand each middleware's signature.
3. For each middleware listed in AUDIT.md Critical #2, port it to canonical-loop. The canonical-loop middleware pattern is at src/canonical-loop/middlewares/ (or wherever the existing canonical middlewares live — find via grep).
4. ADDITIVE ONLY — do not change any legacy-loop behavior. Goal is to make canonical run the SAME safety stack legacy does.
5. Add per-middleware unit tests in test/canonical-loop-middlewares/ if any are missing. Mirror legacy-loop tests where they exist.

Middlewares to port (from AUDIT.md Critical #2):
- loop-detection
- dead-end nudge
- post-commit nudge
- hallucination check
- action-claim check
- self-check
- mid-turn-evidence-stale
- force-tool-use
- post-turn-detector
- auto-route-build-app (port only if AUDIT R13 doesn't render it moot — read R13 first)

## Out of scope
- Changing legacy behavior.
- Migrating any caller from legacy to canonical (that's P4.C3-C5).
- New middlewares (this is parity, not feature work).

## Done-when
1. Every middleware named above has a canonical-loop equivalent.
2. Real chat smoke test still passes (run /senior-engineer chat: "what's 2+2") — no regression.
3. tsc clean.
4. Existing test suite passes (vitest).

## Smoke test
1. `npm run dev:nowatch` → server boots.
2. Real chat turn via curl or browser: send a message, get a response with at least one tool call.
3. Run `node node_modules/vitest/vitest.mjs run test/canonical-loop` if such tests exist.

## Commit
`feat(canonical-loop): port legacy safety middlewares (AUDIT Critical #2, P4.C2)`

Do NOT push.

## Report — same format as P4.C1, with TESTS populated this time.
```

---

## P4.C3 — Migrate cron + autopilot callers to canonical

```
You are a fresh Claude Code session executing one chunk of the LAX audit refactor.

Skill: /senior-engineer
Chunk: P4.C3
Title: Migrate cron + autopilot runAgent callers to canonical-loop

## Context
P4.C1 inventoried the callers; P4.C2 ported missing middlewares. Now we
migrate the FIRST batch — cron-scheduled missions and the autopilot loop —
from legacy `runAgent` to canonical.

## In scope
1. Read `docs/runagent-caller-inventory.md` (P4.C1's output).
2. From the "cron" and "autopilot" buckets, migrate each caller from `runAgent(...)` to the canonical equivalent (likely `runCanonicalTurn` or similar — find via grep in src/canonical-loop/).
3. Preserve EVERY observable behavior: provider, model, timeouts, error handling.
4. Per-caller smoke test: trigger the cron / autopilot path and verify it completes.

Specific known callers (verify against P4.C1 inventory):
- `src/cron-service.ts` (cron job runner)
- `src/autopilot/loop.ts` (autopilot turn)

## Out of scope
- Sub-agent / worker / voice / delegation callers (those are P4.C4-C5).
- Deleting the legacy loops (that's P4.C6).
- Touching the canonical-loop's internal state machine.

## Done-when
1. Every cron + autopilot caller routes through canonical.
2. `git grep -n "runAgent(" src/cron-service.ts src/autopilot/` returns zero hits (or only comments).
3. tsc clean.
4. Server boots, /api/health 200.
5. Trigger an autopilot turn manually (autopilot_start tool); verify it produces output.

## Smoke test
Boot server. Run a one-shot cron job (e.g. trigger a manual mission via the API). Watch logs for canonical-loop op events.

## Commit
`refactor(canonical-loop): migrate cron + autopilot to canonical path (P4.C3)`

Do NOT push.

## Report — standard format.
```

---

## P4.C4 — Migrate sub-agent + worker callers to canonical

```
You are a fresh Claude Code session executing one chunk of the LAX audit refactor.

Skill: /senior-engineer
Chunk: P4.C4
Title: Migrate sub-agent + worker runAgent callers to canonical-loop

## Context
Continues P4.C3. Migrates the next two caller buckets:
- Sub-agents spawned via `Handler.spawnAgent` (`src/server/handler-events.ts:127` calls `runAgent`)
- Worker-pool submissions (`src/workers/*` if any call `runAgent` directly)

This is the HIGHEST-RISK chunk in P4. Sub-agent spawning is on the
hot path for primal_run_build_plan, agent_spawn tool, and the chunk-runner
auto-build loop. A regression here breaks the whole multi-agent surface.

## In scope
1. Read `docs/runagent-caller-inventory.md`.
2. Migrate `src/server/handler-events.ts:127` `runAgent` call to canonical.
3. Migrate any other caller in the sub-agent / worker-pool buckets.
4. Preserve observable behavior:
   - Tools list passed to provider (already resolved via P1.C4's resolveToolsForRequest)
   - Worktree creation when requiresWorktree=true
   - Streaming events to EventBus.handler:* topics
   - Result aggregation + handler:agent-result emission
   - Timeout + abort semantics

## Out of scope
- Voice / delegation callers (P4.C5).
- Deleting legacy loops (P4.C6).

## Done-when
1. `git grep -n "runAgent(" src/server/handler-events.ts` returns zero (or only comments).
2. `git grep -n "runAgent(" src/workers/` returns zero.
3. tsc clean.
4. End-to-end test: spawn a chunk-runner via primal_run_build_plan, verify it produces a STATUS:done|blocked|partial report (any of the three is fine — we're testing the path, not the chunk).
5. Spawn a builtin-researcher via agent_spawn, verify it returns a result.

## Smoke test
Real end-to-end: `primal_run_build_plan({project_dir: "mygroomtime", starting_chunk: 7, max_chunks: 1})`. Watch logs for canonical-loop op events. Confirm field-agent completes and reports.

## Commit
`refactor(canonical-loop): migrate sub-agent + worker spawn to canonical (P4.C4)`

Do NOT push.

## Report — standard format. Include in NOTE: how you handled the streaming-event compatibility (EventBus.handler:* topics).
```

---

## P4.C5 — Migrate voice + delegation-handoff callers

```
You are a fresh Claude Code session executing one chunk of the LAX audit refactor.

Skill: /senior-engineer
Chunk: P4.C5
Title: Migrate voice + delegation-handoff runAgent callers

## Context
Last migration chunk before legacy-loop deletion. Voice has its own
quirks — a `voice_visual` tool, a different end-of-turn write path
(`src/memory/end-of-turn-write.ts`), and a per-turn STT-finalize trigger
(per AUDIT.md R3).

The canonical-loop wasn't designed with voice latency in mind: idle-timeout
(600s) and lease semantics need verification. Don't migrate voice without
benchmarking warm-path latency before AND after.

## In scope
1. Read `docs/runagent-caller-inventory.md` voice + delegation-handoff entries.
2. Migrate each caller to canonical.
3. For voice specifically: benchmark warm-path latency (one prompt, end-to-end ms from STT-finalize → first audio chunk out) before the migration; after migration, verify it's within +/- 100ms of baseline. Document the numbers in the commit message.
4. Delegation-handoff is in `src/routes/chat/delegation-handoff.ts` (read first).

## Out of scope
- Deleting legacy loops (P4.C6).
- Changing voice tool surface.

## Done-when
1. Voice + delegation paths route through canonical.
2. `git grep -n "runAgent(" src/voice/ src/routes/chat/delegation-handoff.ts` returns zero.
3. tsc clean.
4. Voice warm-path latency stays within +/- 100ms of pre-migration baseline (numbers in the commit message).

## Smoke test
Real voice turn (browser): say a 3-second prompt, time first audio chunk out. Run twice (warm). Compare to baseline.

## Commit
`refactor(canonical-loop): migrate voice + delegation to canonical (P4.C5)

Voice warm-path latency before: <ms>
Voice warm-path latency after: <ms>
Delta: <ms> (within +/- 100ms target)`

Do NOT push.

## Report — standard format. The latency numbers go in NOTE if commit message can't fit them.
```

---

## P4.C6 — Delete legacy loops

```
You are a fresh Claude Code session executing one chunk of the LAX audit refactor.

Skill: /senior-engineer
Chunk: P4.C6
Title: Delete legacy agent-turn loops (AUDIT Critical #1)

## Context
After P4.C3/C4/C5, ZERO callers should reach `runAgent` (the legacy
function in src/agent.ts) or the legacy provider-specific loops
(run-anthropic.ts, run-standard.ts, agent-codex/run-http.ts) or the
gated unified loop (agent-loop/run.ts).

This chunk verifies that AND deletes the dead code.

## In scope
1. Verify zero callers:
   - `git grep -nE "\\brunAgent\\(" src/` — expect 0 (or only comments / self-reference inside agent.ts).
   - `git grep -n "from.*run-anthropic" src/` — expect 0 outside the file itself.
   - `git grep -n "from.*run-standard" src/` — expect 0 outside the file itself.
   - `git grep -n "from.*agent-codex/run-http" src/` — expect 0 outside the file itself.
   - `git grep -n "from.*agent-loop/run" src/` — expect 0 outside agent-loop/.
2. If ANY grep returns a live caller, STOP and report STATUS: blocked with the call site. Do NOT delete.
3. If all grep checks pass, delete the files:
   - `src/agent.ts` (the runAgent wrapper)
   - `src/providers/run-anthropic.ts`
   - `src/providers/run-standard.ts`
   - `src/agent-codex/run-http.ts`
   - `src/agent-loop/run.ts`
   - The `LAX_UNIFIED_LOOP` env flag check (now dead) — find via grep, remove.
4. Update `src/providers/index.ts` to remove T1 exports (`getAdapter` etc) — this completes AUDIT P2.

## Out of scope
- ANY caller migration (should already be done by C3/C4/C5).

## Done-when
1. All 5 files deleted.
2. tsc clean.
3. Server boots, /api/health 200.
4. End-to-end smoke: chat turn works, agent_spawn works, primal_run_build_plan works (one chunk).

## Smoke test
Real chat turn + spawn a researcher + run primal_run_build_plan one chunk. All three must complete.

## Commit
`chore: delete legacy agent-turn loops (AUDIT Critical #1, P4.C6)

Net ~<LOC> removed. Canonical-loop is now the only agent-turn path.`

Do NOT push.

## Report — standard format. Include LOC removed in NOTE.
```

---

## Post-P4 chunks (small, can be done by fresh sessions or parent)

After P4.C6 lands, these collapse to small mop-up chunks:

### P2.C2 + P2.C3 — Delete dead adapter T1 registry

After legacy loops die, T1 (`getAdapter` in src/providers/index.ts) has zero callers. Verify with grep, then delete. Likely a single small commit. The `providers/adapter/` T2 surface stays as canonical.

### P3.C2 — Wire RetryContext into surviving retry layers

L2/L3/L4 (per-loop stream-error retries) died with the legacy loops. Only L1 (`tool-executor.withRetry`), L5 (`routes/chat.ts:525-580` cascade), and L6 (warm-pool subprocess) remain. Per docs/retry-strategy-canonical.md, plumb `RetryContext` into those three. One medium-sized chunk.

### P5 — Cross-cutting Criticals

- **P5.C1**: Fix two-writer drift on session.messages (Critical #3) — likely small (delete the snapshot-and-revert hack in routes/chat.ts:287-433).
- **P5.C2**: Scope `_localNoToolModels` per-adapter-instance (Critical #4).
- **P5.C3**: Anthropic CLI prompt-build dedup (Critical #7) — merge warm-pool + cold-spawn paths.
- **P5.C4**: Replace WS chat HTTP self-loop with direct canonical-op subscription (Critical #10).

Each is independently small; can be fresh-session chunks or inline depending on preference.

---

## Standard report format (reminder)

Every chunk returns this exact shape:

```
STATUS: done | blocked | partial
CHANGED: <files changed/deleted, comma-separated>
TESTS: <pass>/<total> | n/a
NEW_FAILURES: <test names introduced, or none>
PRE_EXISTING_FAILURES: <test names that already failed before this chunk, or none>
BEHAVIOR_RISKS: <observable behavior changes, or none>
ROLLBACK: git revert <sha>  OR  git reset --hard HEAD~1
NOTE: <anything the parent needs to know>
```
