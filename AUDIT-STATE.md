# Audit Refactor — Live State

**Purpose.** Single source of truth for where the audit refactor stands. Read this file (after `git pull`) on any machine, in any Claude Code session, to know exactly what's done, what's next, and the rules I'm operating under. Update after every chunk lands on remote.

**Last updated:** 2026-05-12, after P4.C3.
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

**Net so far:** ~3000 LOC removed, ~2700 LOC added (mostly canonical middlewares + tests + design docs). The canonical-loop now runs the same safety stack legacy did. One canonical resolver replaced five drifting filter sets. One adapter-agnostic non-chat runner exists.

---

## Up next

### P4.C4 — Migrate sub-agent + worker-pool callers (HIGH RISK)
**Why high risk:** sub-agent path = hot path for `agent_spawn`, `primal_run_build_plan`, chunk-runner workers. A regression breaks the whole multi-agent surface and won't surface until someone spawns an agent.

**Specific call sites still using `runAgent` (verified by P4.C3 report):**
- `src/server/handler-events.ts:127` (`Handler.spawnAgent` → `runAgent`)
- `src/server/background-jobs.ts:249` (worker-pool app-builder callback)

**Parent-review required** before push. Skim the report's NOTE for: EventBus `handler:*` streaming preservation, worktree creation (requiresWorktree path), result aggregation, abort semantics. Smoke test MUST spawn a chunk-runner end-to-end via `primal_run_build_plan({project_dir: "mygroomtime", starting_chunk: <next>, max_chunks: 1})`.

The full fresh-session briefing is in **AUDIT-HANDOFF-P4.md** under "P4.C4." Paste verbatim into a fresh Claude Code session.

### P4.C5 — Migrate voice + delegation-handoff callers
Lower risk than C4 but needs voice latency benchmark (warm-path must stay within +/- 100ms of pre-migration). Can run in parallel with C4 (different files: voice/* + routes/chat/delegation-handoff.ts vs handler-events.ts + workers/*).

### P4.C6 — Delete legacy loops
Sequential — depends on C4 + C5 both green. Verify `git grep -nE "\\brunAgent\\(" src/` returns zero. Delete: `src/agent.ts`, `src/providers/run-anthropic.ts`, `src/providers/run-standard.ts`, `src/agent-codex/run-http.ts`, `src/agent-loop/run.ts`, and the `LAX_UNIFIED_LOOP` env flag.

### After P4 — mop-up chunks
- **P2.C2+C3** — Delete dead T1 adapter registry (collapses to one chunk post-P4)
- **P3.C2** — Wire `RetryContext` into L1/L5/L6 retry layers
- **P5.C1** — Fix two-writer drift on `session.messages` (AUDIT Critical #3)
- **P5.C2** — Scope `_localNoToolModels` per-adapter-instance (Critical #4)
- **P5.C3** — Anthropic CLI prompt-build dedup — merge warm-pool + cold-spawn paths (Critical #7)
- **P5.C4** — WS chat HTTP self-loop → direct canonical-op subscription (Critical #10)

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
