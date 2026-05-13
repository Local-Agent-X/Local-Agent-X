# Audit Refactor — Live State

**Purpose.** Single source of truth for where the audit refactor stands. Read this file (after `git pull`) on any machine, in any Claude Code session, to know exactly what's done, what's next, and the rules I'm operating under. Update after every chunk lands on remote.

**Last updated:** 2026-05-12, **AUDIT REFACTOR COMPLETE.** Laptop landed P4.C6 + every P5 chunk + P3.C2 + multiple regression fixes in one push.
**Branch:** `main`. Always work directly on `main` — no branches. Each chunk = one commit.
**Repo:** github.com/petermanrique101-sys/Local-Agent-X

---

## Done (committed + pushed)

| Phase | Commit | What |
|---|---|---|
| P0.C1 | `1c5cd37` | Deleted 19 confirmed-dead files (AUDIT §2.6.A1+A2) |
| docs | `fde7719` | AUDIT.md Cluster 11 (tool filtering) + AUDIT-PLAN.md |
| P0.C2 | `b124023` | Stripped 85 unused imports/locals across 62 files |
| P1.C1 | `c7635cb` | Design doc for canonical tool resolver |
| P1.C2 | `ff16b37` | `resolveToolsForRequest` + `audiences` field + transitional tagger |
| P1.C3 | `b3eb2e9` | Migrated `filterToolsForMessage` to canonical resolver (10/10 parity tests) |
| P1.C4 | `b06851d` | Migrated spawned-agent path + killed `isCodeRole` regex; added `requiresWorktree` |
| P2.C1+P3.C1+P3.C3 | `da50c2b` | Adapter + retry design docs + retry dead-code gut (~266 LOC removed) |
| handoff | `0441b8e` | AUDIT-HANDOFF-P4.md fresh-session briefings |
| P4.C1 | `474bcdb` | Inventoried 11 runAgent callers in `docs/runagent-caller-inventory.md` |
| openai-compat fix | `14dc62a` | Tool-call-text-extractor (catches `{"name":...,"arguments":{...}}` and `{"action":..,"ref":..}` JSON leaks from Ollama models) |
| P4.C2 | `5617e30` | Ported 10 legacy safety middlewares to canonical-loop (459-line test file, 26 new tests) |
| UI redact | `b8c1e42` | Server emits `stream_redact` event; client swaps bubble text after extraction |
| P4.C3 | `e339a1c` | Migrated cron + autopilot callers to canonical-loop via new `runAgentViaCanonical`. Hard-timer threading complete |
| docs | `c8886df` | AUDIT-STATE.md (this file) + cross-machine self-prompt |
| P4.C1 update | `6f77ebb` | Inventory rewrite (other machine) |
| **P4.C4** | `b181693` | Sub-agent (handler-events.ts) + worker-pool app-builder + workers/worker-entry.ts subprocess migrated to canonical. EventBus.handler:* stream bridging added so spawned-agent text reaches the AGENTS sidebar |
| **P4.C5** | `90f1446` | Voice + delegation-handoff migrated. Voice overhead bench: 18-26ms structural, well inside +/-100ms budget |
| test fix | `c876052` | Supervisor-surface test fixtures rewired through tagToolsByAudience (consequence of P1's audience filter) |
| **pre-P4.C6** | `bc91139` | Deleted chat legacy-fallback callers (routes/chat.ts:433, :555) + canonical-chat feature flag. -283 LOC |
| cleanup | `15ebfe5` | Deleted Calenbella-specific test file |
| **P4.C6** | `0780a8b` | Deleted legacy agent-turn loops (agent.ts, run-anthropic, run-standard, agent-codex/run-http, agent-loop/run). Only canonical-loop remains |
| regression | `19dabc6` | Anthropic CLI native-shape tool-call extractor — catches Claude opus emitting `{"name":"X","input":{...}}` as text |
| regression | `f1f5dd4` | Hid agency_* tools from supervisor surface (SUPERVISOR_EXCLUDED) — Claude routed `agency_create` instead of `agent_spawn` due to description similarity, hung 135s |
| tidy | `9fd970d` | MCP_HIDDEN_TOOLS aligned with canonical 3-tool delegation |
| UX | `a584748` | Suppressed canonical bg_op_* sidebar cards for agent_spawn ops |
| **P5.C3** | `e064bc0` | Anthropic CLI warm-pool + cold-spawn prompt builders unified (Critical #7) |
| **P5.C2** | `a64f22f` | No-tool-support cache keyed by (baseURL, model) instead of model alone (Critical #4) |
| **P5.C1** | `fe40604` | Removed session.messages two-writer drift (Critical #3) |
| **P5.C4** | `5e0207b` | WS chat dispatches directly into chat-turn (no HTTP self-loop, Critical #10) |
| **P3.C2** | `169b652` | RetryContext with correlationId + shared budget wired into L1 retries (Critical #5) |

**FINAL NET:** ~4,500 LOC removed (legacy loops + dead retry + tool-filter drift + dead files). Every AUDIT.md Critical addressed. One canonical loop. One canonical resolver. One canonical adapter registry path. Shared retry budget with correlationId. The whole audit is shipped.

---

## Up next

### Nothing required. The refactor is done.

What lands here next is OPTIONAL polish or NEW PRODUCT WORK. Some leftover items worth considering:

- **pauseCallback port** (login/2FA detector) — spawned/voice/delegation agents that hit a login mid-task currently run to wall-clock instead of pausing. Flagged in P4.C4 + C5 reports.
- **query-pipeline middleware** — was at `agent.ts:50` (now deleted), no callers register today but the surface is gone.
- **delegation-handoff image projection** — chat has same gap.
- **Smoke verification** on this machine — re-run `agent_spawn researcher` and `primal_run_build_plan one chunk` to confirm regression fixes (`19dabc6` + `f1f5dd4`) work end-to-end here. My earlier smokes ran on the buggy pre-fix code.

**Per memory `project_top_10_gaps_2026_04`, the NEXT product move is full-duplex voice (gap #1).** That was the declared next spike before the audit interlude. The architecture refactor unblocks it because canonical-loop's cancel/replay/reconnect semantics + correlationId tracing make voice's barge-in + interruption flows tractable.

---

## Archive of completed chunks (was "Up next" before everything shipped)

### P4.C6 — Delete legacy loops (mechanical, low risk now) ✅ DONE in commit `0780a8b`

Every non-chat caller is migrated. Every chat fallback caller is deleted. The legacy loop files are dead code. This chunk deletes them and the `LAX_UNIFIED_LOOP` env flag.

**Verification before deletion:**
```
git grep -nE "\brunAgent\(" src/
```
Expected: zero matches (or only inside `src/agent.ts` itself + comments).

**Files to delete:**
- `src/agent.ts` (the `runAgent` wrapper)
- `src/providers/run-anthropic.ts`
- `src/providers/run-standard.ts`
- `src/agent-codex/run-http.ts`
- `src/agent-loop/run.ts` (gated unified loop)
- Any helper files imported only by those (e.g. `run-anthropic-helpers.ts`, `run-standard-helpers.ts`, `run-http-helpers.ts`) — verify via grep before deletion
- Remove `LAX_UNIFIED_LOOP` env check wherever it lives
- Update `src/providers/index.ts` to remove T1 (`getAdapter`) exports — completes AUDIT P2 in the same commit

**Smoke after deletion:** server boots, /api/health 200, real chat turn produces a response, spawn a researcher via agent_spawn, run primal_run_build_plan one chunk. All three must complete.

**Briefing:** in `AUDIT-HANDOFF-P4.md` under "P4.C6." Paste verbatim into a fresh executor session.

### After P4 — mop-up chunks
- **P2.C2+C3** — Delete dead T1 adapter registry (now folded into P4.C6's `providers/index.ts` cleanup if executed together; otherwise small standalone chunk)
- **P3.C2** — Wire `RetryContext` into L1/L5/L6 retry layers (L2/L3/L4 die with the legacy loops in P4.C6)
- **P5.C1** — Fix two-writer drift on `session.messages` (AUDIT Critical #3 — but note: routes/chat.ts dropped ~530 lines in `bc91139`; verify Critical #3 is still live before scoping)
- **P5.C2** — Scope `_localNoToolModels` per-adapter-instance (Critical #4)
- **P5.C3** — Anthropic CLI prompt-build dedup — merge warm-pool + cold-spawn paths (Critical #7)
- **P5.C4** — WS chat HTTP self-loop → direct canonical-op subscription (Critical #10)
- **NEW GAPS surfaced during P4.C4/C5** (consider as P5 candidates):
  - `pauseCallback` ("please log in / needs 2FA" detector) didn't port to canonical — spawned/voice/delegation agents that hit a login mid-task now run to wall-clock instead of pausing for human handoff
  - query-pipeline pre/post middleware (was in `agent.ts:50`) doesn't run on canonical; no callers register today but the surface is gone
  - delegation-handoff doesn't project user images into the seeded canonical user message (chat has the same gap)

P5 chunks are mostly independent and can fan out aggressively.

---

## Operating rules (current policy)

1. **Each chunk = one commit on `main`.** No branches.
2. **Fresh sessions execute, parent (me) reviews + pushes.** Briefings in `AUDIT-HANDOFF-P4.md`.
3. **Fire-and-forget push:** OK for low-risk chunks (deletions, docs, mop-up). Requires:
   - STATUS: done in the report
   - BEHAVIOR_RISKS: none (or trivial)
   - Smoke test passed
4. **Parent skim before push (~2 min):** P4.C4 sub-agent migration, P4.C5 voice latency, P4.C6 deletion verification.
5. **Parallel-safe pairs:** P4.C4 + P4.C5 (different files). P5.C1/C2/C3/C4 mostly mutually independent.
6. **Cross-machine continuation:** another Claude Code session on another machine can `git pull` + read this file + read AUDIT-HANDOFF-P4.md + execute the next chunk. No inherited context required — that's the whole point of the chunk-briefing pattern.

---

## Lessons learned from prior chunks (don't repeat)

- **P4.C2 lesson — don't modify `~/.lax/settings.json` during smoke tests.** Fresh session edited it to switch providers for a smoke run, couldn't revert (auto-mode classifier denied the second edit), and left Peter's default flipped. Use a session-scoped provider override or worker-pool config for smoke tests instead. If a chunk's smoke test needs a specific provider, document it as a precondition in the briefing — don't let the fresh session paper over it.
- **P4.C2 lesson — Anthropic CLI's MCP fan-out is invisible to canonical middlewares.** When chat goes through stream-cli, the CLI handles MCP tools internally and reports a single finalized assistant message with no `tool_call_requested`. Middlewares can't see the inner tool calls. Doesn't cause regressions (everything returns `continue`) but post-turn-detector won't catch missing-tool patterns on CLI-driven Anthropic turns. Future tidy chunk.
- **P1.C2 lesson — `EAGER_TOOLS` in registry-build.ts was an orphan.** Adding tools there did nothing because no live caller read `eagerTools` from `buildToolRegistry()`. The real chat-side filter was `CORE_TOOL_NAMES` in `tool-filter.ts`. Lesson: when fixing a "tool not in schema" bug, find the ACTUAL gate the chat path uses, not the gate that looks like it should be the source of truth.
- **General — memory scope.** My memory at `~/.claude/projects/c--Users-manri-local-agent-x/memory/` is for LAX itself, NOT the apps inside `workspace/apps/`. Don't save feature lists for MyGroomTime, ScanProgress, Kraken bot, etc. Those rot fast and have authoritative homes. See `feedback_memory_scope_lax_only.md`.

---

## For Future-Me on another machine

If you're reading this in a fresh Claude Code session on another computer:

1. **You're me, working on the LAX audit refactor.** This file is the orchestration state — read it before doing anything.
2. **Pull first:** `git pull origin main`. Make sure you're on `main`.
3. **Look at the "Up next" section.** That's what needs to happen.
4. **For the next P4 chunk:**
   - Open `AUDIT-HANDOFF-P4.md`
   - Find the section for the next chunk (P4.C4 first; then C5; then C6)
   - Spawn a NEW fresh Claude Code session and paste that chunk's briefing verbatim
   - When the fresh session returns its report, follow the policy above (skim vs fire-and-forget)
   - Push the commit, update this file ("Done" table + "Up next" section), commit + push the update
5. **For mop-up chunks (P2.C2+C3, P3.C2, P5.C*):** smaller and lower-risk. You can execute them inline (don't need a fresh session) if you want speed over independent review.
6. **If you finish the refactor:** the next product move per memory is full-duplex voice (gap #1 from `project_top_10_gaps_2026_04`). Ask Peter.

**Things NOT to do:**
- Don't modify `~/.lax/settings.json` (see lesson above)
- Don't add error handling, fallbacks, or "improvements" to code you didn't touch (smallest correct change rule)
- Don't save user-project state to memory (MyGroomTime / ScanProgress / etc are noise to this memory scope)
- Don't push without verifying the report's STATUS + BEHAVIOR_RISKS + smoke test
- Don't run two chunks in parallel unless they're confirmed-disjoint pairs (P4.C4 + P4.C5 is the only known safe pair right now)

The audit's whole point is one canonical path replacing N drifting ones. Stay focused on that. After P4-P5 lands, the architecture pays you back: replay-on-reconnect for cron, full retry budget control, single correlationId across the stack, voice migration unblocked.

---

## Self-prompt — paste this into a fresh parent session on another machine

Use this to bootstrap the next parent session (the orchestrator role, NOT a chunk-executor role). It gets you matching the operating style this branch has been running on.

```
You are the parent / orchestrator session for the LAX audit refactor.

Read C:/Users/manri/local-agent-x/AUDIT-STATE.md first. It has the live status, what's done, what's next, and the lessons learned. Then read AUDIT-PLAN.md and AUDIT-HANDOFF-P4.md if you need the chunk-level details.

You are not the one writing the chunks — fresh Claude Code sessions execute them per the briefings in AUDIT-HANDOFF-P4.md. You orchestrate: hand Peter the next chunk's prompt, verify the report, push the commit, update AUDIT-STATE.md, repeat. For low-risk chunks (deletions, docs, mop-up) you can push fire-and-forget. For high-risk chunks (P4.C4 sub-agent migration, P4.C5 voice) skim the report's NOTE + BEHAVIOR_RISKS before pushing.

Operating style on this branch:

- Short. Direct. No filler ("let me", "I'll now", "great question"). No preamble. State results first.
- Casual register matches Peter's. Fragments fine. Drop articles for concision.
- Be honest about tradeoffs. If a fix is a workaround vs. root-cause, say so.
- Senior-engineer methodology: smallest correct change. No drive-by refactors. Root-cause every bug. Don't add error handling for cases that can't happen. Don't catch errors you can't act on. Trust internal code; validate at boundaries.
- File modifications use Edit / Write tools, NEVER bash heredoc / python -c / sed-replacements. The system-prompt rule on this is hard.
- Don't push when you mean "commit." Don't commit without staging deliberately. Each chunk = one commit.
- Don't run two chunks in parallel unless they're a known-disjoint pair (P4.C4 + P4.C5 is the only confirmed safe pair right now).
- Don't save user-project state to memory. Memory at ~/.claude/projects/c--Users-manri-local-agent-x/memory/ is LAX-only. MyGroomTime, ScanProgress, Kraken bot, etc are workspace/apps/* user projects — noise to this scope. See feedback_memory_scope_lax_only.md.
- When a fresh session's report includes a "stray" side-effect (e.g. P4.C2 left ~/.lax/settings.json flipped), call it out to Peter before pushing. Don't paper over it.
- Server start: always npm run dev:nowatch (watcher off). Log capture to /tmp/sax-server.log. Standard sequence: kill any existing 7007 listener via PowerShell Stop-Process, npm run dev:nowatch & in background, wait for 7007 to bind via netstat poll, curl /api/health for 200.
- Sync repo at ~/.lax/sync-repo/ has a 5s debounced push-on-state-change. Any mutation (pin/unpin/project-delete/folder-delete) pushes to the sync remote within ~5s. Means changes on one machine reach the other almost immediately.
- Server PID lives in port 7007 listener; tsx is the runner; no compile step needed before restart.
- Defender is the only AV. AVG + McAfee were removed because three AVs in parallel corrupted files mid-write last month.

What the user expects from you:

- Tight progress updates between chunks. One sentence per state change.
- Recap of what changed after every edit or commit (Peter needs to know what moved).
- Don't preemptively announce silence ("I won't respond unless you ask") — respond to every message.
- Always perma-fix, not workarounds — except probes/debugging where a quick check is the point.
- "/schedule" offers are rare. Default: don't offer one. Only if the current turn produced a named artifact with a future obligation that has a concrete date.
- Don't propose Haiku for classifiers. Don't propose new API keys (everything routes through Peter's existing Anthropic OAuth + Codex CLI auth).
- Sub-features can't require sk-ant-api03 or OPENAI_API_KEY. CLI auth only.

What's queued right now:

Read AUDIT-STATE.md "Up next" section. The first chunk listed there is your next move — find its briefing in AUDIT-HANDOFF-P4.md, hand the prompt to Peter to paste into a fresh executor session, then wait for the report.

When in doubt, defer to Peter's call. He's not a career engineer; he's a self-taught builder running NutriShop McKinney and building LAX. He knows what he wants; ask once when ambiguity would change the diff, not three times.
```
