# Memory System — Open Items

Saved 2026-04-26. After phases 1–4 of the memory cleanup (logger, telemetry,
route splits, MemoryManager facade, llm-dispatch consolidation, JobScheduler,
duplicate-call fix), an honest audit of the orchestrator submodules turned up
several modules that are computed-but-unused, plus a handful that look like
enthusiasm rather than load-bearing. This file is the to-do for the next pass.

## Verifiably load-bearing (do not touch)

- `src/emotional-memory.ts` — fires every turn, output reaches the agent
- `src/memory-compression.ts` — prevents unbounded disk growth
- `src/memory-importance.ts` (archival side only) — daily decay + auto-archive

## Dead integrations to either wire up or delete

These modules compute output that nothing consumes. Each is a binary choice:
hook it into retrieval, or remove the cost of maintaining it.

- **Memory tiers** — `src/memory-tiers.ts` runs `reclassifyAll()` daily,
  persists HOT/WARM/COLD/ARCHIVE assignments, but `searchTiered()` /
  `deepRecall()` are never called from `src/memory/index-search.ts`. Search
  ignores tier metadata entirely.
- **Importance ranking in search** — `src/memory-importance.ts` computes
  scores daily, but `rankMemories()` is never called during retrieval. Only
  archival uses the scores.
- **Predictive prefetch** — computes "you usually work on X at 3pm Tuesday"
  every background cycle, logs it as telemetry, then nothing acts on it.
  No cache preload, no search bias.
- **Memory graph** — `src/memory-graph.ts` is built and maintained as a side
  artifact (~7 edges added per cycle), but never queried by retrieval or
  context building.

## Enthusiasm tier — emit signals but unclear they reach the agent

These are wired into the conversational module pipeline but only emit
priority-3-to-7 signals into a fusion pool. No telemetry shows whether the
signals actually reach the context window or change agent behavior.

- `src/proactive-memory.ts` (~452 LOC) — pattern-learns every turn
- `src/narrative-memory.ts` (~392 LOC) — story-arc detection
- `src/unspoken-detector.ts` — absence/change detection
- `src/inside-references.ts`
- `src/growth-tracker.ts`
- `src/anticipatory-care.ts`
- `src/shared-history.ts`

## Probably-useful-but-never-measured

These have sound theory and run by default, but no before/after data
demonstrates they improve retrieval quality.

- `src/memory-mmr.ts` — runs on every search by default
- `src/memory-hyde.ts` — opt-in via `options.hyde === true`
- `src/memory-reranker.ts` — opt-in via `options.rerank === true`
- `src/memory-resolver.ts` — Mem0-style write-time resolution. Verify whether
  callers actually apply the returned `{op, targetId}` decisions, or whether
  the resolver is computing decisions that get ignored.

## Suggested next-pass plan, in order of confidence

1. **Cut the dead-clear stuff first** — delete predictive-prefetch and either
   wire memory-graph into retrieval or stop the background job that builds it.
   Highest confidence, smallest blast radius. Estimated ~600 LOC removed.

2. **Force the tiers/importance integrations to a binary state** — either
   add `searchTiered()` to the default search path and consult importance
   scores in ranking, OR delete the daily reclassification and scoring
   background work. Don't leave them computing output nobody reads.

3. **Add real measurement before touching the rest** — write a replay-test
   harness with on/off flags for HyDE / MMR / reranker. Compare retrieval
   quality. Only then decide whether they earn their keep.

4. **Audit the signal pool** — instrument the fusion logic so we can see which
   signals actually reach the context window each turn. Without that, the
   conversational modules (proactive, narrative, unspoken-detector, etc.) are
   running on faith.

## What this audit revealed about the meta-process

The memory system was declared "done" twice — once after the original 14-module
build, and again after this session's cleanup. Both times the claim rested on
"the code compiles and runs," not on "the modules demonstrably help." The
honest signal that memory is done is not "no obvious smells left," it's
"the system is being measured and the parts pulling weight are clear."
That signal does not exist yet.
