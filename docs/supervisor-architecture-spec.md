# Supervisor Architecture — Spec

## The spine

> **The main agent is a supervisor, not a worker.** It routes, summarizes, interrupts, and recovers operations; long-running execution happens in isolated worker sessions with durable state, priority scheduling, heartbeats, and resumable leases.

This is the design that simultaneously delivers:
- **System doesn't break** — bad work crashes a worker, never the supervisor
- **Concurrent chats** — multiple sessions never block each other because none of them does heavy work
- **Voice as orchestrator** — voice agent's toolbox is supervisor-only; latency stays sub-second
- **Sub-agents that aren't junior devs** — context-pack builder hands them everything they need
- **Doesn't give up** — when work fails, supervisor decides retry/escalate/accept; never silently dies

The worker pool is the muscle. The supervisor contract is what makes it trustworthy.

## Pre-flight test result (2026-04-28)

`scripts/test-claude-cli-concurrency.mjs` — spawned 3 concurrent `claude -p` subprocesses sharing one OAuth token:

```
[#1] OK in 6387ms (exit=0)
[#2] OK in 5803ms (exit=0)
[#3] OK in 5830ms (exit=0)

Total wall time: 6387ms
Avg per-call:    6007ms
Ran in parallel: YES
```

**Conclusion:** OAuth-CLI multi-instance works. Workers can each spawn their own `claude -p` without rate-limit / session conflict. No need for a single-CLI-lane fallback for OAuth users.

---

## 1. Priority lanes

Workers are pulled from a single pool, but tasks are scheduled across **three priority lanes**:

| Lane | Reserved slots | What runs there |
|---|---|---|
| **Interactive** | At least 1, always | Voice turns, chat-direct turns, anything where the user is actively waiting on a screen |
| **Build** | Up to N-1 | App builds, autopilot rounds, anything user-initiated but background-acceptable |
| **Background** | Up to N-2 | Cron missions, memory consolidation, dream cycles, op cleanup |

Rules:
- A long-running build can NEVER starve interactive. Reserved slot guarantees the user always has a path.
- Background work yields to build work yields to interactive work. If a background task is mid-execution and an interactive request lands with no free worker, background pauses (or finishes its current step then yields), interactive runs, background resumes.
- Voice gets ABSOLUTE priority — interactive lane preempts background for voice turns specifically.

Implementation: each `submitOp` includes a lane parameter. Pool dispatcher chooses worker based on lane availability + reservation rules.

## 2. Provider capability matrix

Each provider declares its capabilities once at registration time. Routing is explicit, not vibes-based:

```ts
interface ProviderCapabilities {
  id: string;                    // "cliOauth" | "httpKey" | "localOllama" | etc.
  supportsTools: boolean;        // can call tools natively?
  supportsVision: boolean;       // image_url content blocks?
  supportsLongContext: boolean;  // >100K tokens?
  supportsStreaming: boolean;    // SSE / partial responses?
  supportsJsonMode: boolean;     // structured output enforcement?
  supportsLocalFiles: boolean;   // can read local files (CLI providers)?
  maxConcurrent: number;         // hard ceiling per provider
  costTier: "cheap" | "standard" | "premium";
  latencyTier: "fast" | "medium" | "slow";
}
```

When the supervisor decides to spawn a sub-agent, it picks a provider by:
1. Filtering by required capabilities (task says "needs vision" → only providers with `supportsVision`)
2. Within candidates, picking by latency/cost preference for the lane
3. Honoring `maxConcurrent` per provider so we don't oversaturate any one

**Neutral naming**: providers identified by transport+auth shape (`cliOauth`, `httpKey`, `localHttp`), not by vendor name in code/commits. Vendor identity is config data, not source-code identifier.

## 3. Durable event log

Worker progress is appended to disk, not only streamed over WS:

```
~/.lax/operations/<opId>/
  ├─ operation.json       (metadata, status, lease)
  ├─ events.jsonl         (append-only event log)
  ├─ context-pack.json    (the snapshot the worker received)
  └─ artifacts/           (any files the op produced for review)
```

If the UI reloads, the op panel reconstructs from `events.jsonl`. If the worker crashes, the supervisor reads the log to know what was already done. If the user opens a new browser tab, they can subscribe to the live tail of an in-progress op.

WS streaming and disk-append run in parallel — disk is the source of truth, WS is the optimistic delivery channel.

## 4. Heartbeat protocol

Every worker sends a heartbeat to the supervisor every 5s containing:
- Worker ID
- Current op ID (or null if idle)
- Current phase / step description
- Timestamp of last event
- Memory usage

The supervisor watchdog:
- If heartbeat missed for 30s → flag worker as suspect
- If missed for 60s → kill worker (SIGKILL), mark op as `recoverable`
- If three heartbeats in a row show >80% memory budget → recycle worker after current op completes

Recovery: when an op is marked `recoverable`, the supervisor decides:
- If the op is idempotent (configurable per op type) → respawn on a fresh worker, resume from last event
- If not idempotent (e.g. payment, email send) → mark `failed-needs-human`, surface to user

## 5. Worker leases

Every op assigned to a worker carries a **lease**:

```ts
interface OpLease {
  opId: string;
  workerId: string;
  expiresAt: number;       // wall-clock deadline
  renewableUntil: number;  // hard ceiling, can't extend past this
  recoverable: boolean;
}
```

Workers renew their lease each heartbeat. If a lease expires (worker died, network dropped):
- The supervisor reclaims the lease
- The op state file is read to reconstruct progress
- If `recoverable: true` AND `renewableUntil > now`, a new worker is assigned and resumes
- Otherwise the op is marked failed

This kills the "ghost running" pattern — every op is owned by exactly one worker at any moment, and ownership is verifiable.

## 6. Queue backpressure

When all workers are saturated, requests are explicitly queued (not silently dropped or rejected):

```
{
  status: "queued",
  position: 2,
  ahead: ["op_kraken_build (12% complete)", "op_research_x_ai (8 min remaining)"],
  estimatedStart: "~3 min"
}
```

Voice agent uses this to say: "I started it; it's queued behind two builds. Should be running in about three minutes — want me to keep doing other things while we wait?"

Without explicit queue surfacing, the user has no idea if the system is busy or broken. Surfacing the queue makes the system feel alive even when it's busy.

## 7. Interrupt semantics — three distinct controls

"Stop" alone is ambiguous. Define three:

| Control | Effect | When to use |
|---|---|---|
| **Pause** | Worker finishes current step (e.g. current file write), then waits. Op is resumable. | "Hold on, let me look at what you've done so far." |
| **Redirect** | Injects new instruction into the worker's context for the next iteration. Op continues. | "Also add a stop-loss strategy." |
| **Kill** | SIGTERM the worker, mark op as cancelled. Not resumable. | "This is going off the rails, kill it." |

Each maps to a distinct API endpoint and UI affordance. Voice agent has tools for all three.

The autopilot work already shipped Stop (in the "finish current round, then exit" sense) — it maps to Pause here. Kill is the "v2" we deferred. Redirect is the agent_redirect primitive that already exists.

## 8. Context pack builder — first-class module

A new module (`src/context-pack/builder.ts`) packages everything a sub-agent needs into a single payload:

```ts
interface ContextPack {
  task: {
    description: string;       // expanded, not "build the kraken bot"
    successCriteria: string[]; // explicit "you're done when..."
    constraints: string[];     // "don't touch the auth layer"
    notWhatToRedo: string[];   // "kraken-tradingbot already exists; extend it, don't rebuild"
  };
  context: {
    recentTurns: SessionMessage[];   // last N user+agent turns from parent
    referencedFiles: FileSnapshot[]; // files the parent mentioned, pre-loaded
    memoryHits: MemoryEntry[];       // pre-fetched memory matches
    agentsRules: string;             // collected AGENTS.md from scope
  };
  capabilities: ProviderCapabilities[]; // which providers are eligible
  budget: {
    maxIterations: number;
    maxTokens: number;
    maxWallTime: number;
    maxSelfEditCalls: number;
  };
  routing: {
    lane: "interactive" | "build" | "background";
    preferredProvider?: string;  // optional override
  };
}
```

The supervisor builds this once when delegating. The worker spawns with the pack pre-loaded, so it doesn't need to re-search memory, re-read files, re-discover the AGENTS.md rules. Result: workers spin up with maybe 8-15K tokens of pre-baked context vs the ~200 tokens they'd get with a naive "build the kraken bot" delegation.

This is the difference between "junior dev with no context" and "engineer who's been on the team for a month."

## 9. No provider-brand leakage

Per repo rules:
- No `Claude`, `Anthropic`, `OpenAI`, `GPT`, `Gemini`, etc. in code identifiers, comments, log strings, or commit messages
- Use neutral names: `cliOauth` (one provider), `httpKey` (another), `localHttp`, `providerWorker`, `oauthCli`
- Vendor identity lives in config data (`provider.id` strings, env vars), never in source-code symbols
- Existing files like `src/anthropic-client/` are grandfathered for now — rename in a separate cleanup pass

This keeps the codebase portable across vendors and avoids the awkward "we use OpenAI? but it says Claude everywhere" situation when models swap.

## 10. Concurrency test before architecture lock-in

Done. See "Pre-flight test result" at top.

If the test had failed (single-CLI lane needed for OAuth), the worker pool design would split into:
- **HTTP workers** (parallel, full pool size) for httpKey providers
- **CLI worker** (single, serialized queue) for oauthCli providers
- Routing based on which provider the task needed

Since the test passed, the simpler unified pool design works.

---

## Build order

Layer-by-layer, each delivers value independently:

| # | Build | Effort | Unlocks |
|---|---|---|---|
| 0 | **Process supervisor + heap bump** (already in plan) | 1h | Process survives crashes, immediate stability |
| 1 | **Worker pool of 1 + IPC + event routing + durable event log** | 6-8h | Validates the pattern. Main agent stays responsive even with one heavy op. |
| 2 | **Heartbeat protocol + lease management + recovery** | 4-6h | Workers can die without losing the op |
| 3 | **Provider capability matrix + neutral naming refactor** | 4-6h | Routing is explicit, codebase portable |
| 4 | **Context pack builder** | 4-6h | Sub-agents stop acting like junior devs |
| 5 | **Priority lanes + queue backpressure + UI surfacing** | 4-6h | System stays responsive under load, user sees what's happening |
| 6 | **Three interrupt controls (Pause / Redirect / Kill)** | 3-4h | User can steer in real-time |
| 7 | **Worker pool size N + dynamic burst + recycle policy** | 3-4h | Scales to multiple concurrent ops |
| 8 | **Voice-orchestrator path** | 2-3h | The killer demo |

Total: ~30-40 hours of focused work for the full vision. Step 0 is shipping today; step 1 is the load-bearing one — once it's right, everything else is parameter scaling.

## What this guarantees

| Failure mode | Without supervisor contract | With it |
|---|---|---|
| Worker OOMs mid-op | UI dead, all sessions affected | Worker dies, supervisor recycles, op resumed from durable log |
| Worker hangs (silent infinite loop) | User waits forever | Heartbeat misses → killed → op marked recoverable → retried |
| User wants to redirect mid-build | No way to inject | Redirect endpoint pushes new instruction to live worker |
| Long build starves chat | Chat unresponsive | Reserved interactive slot guarantees chat path |
| Browser reloads mid-op | Op state lost from UI | Event log replayed, op panel reconstructs |
| Provider goes down | All workers fail | Capability matrix routes to fallback provider, lease reassigned |
| Two ops both want same files | Race condition / corruption | Per-op worktree (existing pattern), no collision |
| User says "stop" ambiguously | Pick one interpretation, often wrong | Three explicit controls, user picks Pause / Redirect / Kill |

The system that doesn't break or give up isn't one mechanism — it's the composition. The worker pool gives you the muscle, the supervisor contract gives you the guarantees.
