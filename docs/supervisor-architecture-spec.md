# Supervisor Architecture — Spec

## The spine

> **The main agent owns attention. Workers own labor.**

The main agent is a supervisor, not a worker. It routes, summarizes, interrupts, and recovers operations; long-running execution happens in isolated worker sessions with durable state, priority scheduling, heartbeats, resumable leases, and structured checkpoints. The supervisor never blocks on heavy work, so the user always has a responsive thread.

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

## 3. Durable event log + checkpoints

**Event logs are not checkpoints.** The events.jsonl tells us what happened; it does not always give a worker enough state to resume. Two complementary on-disk records:

```
~/.lax/operations/<opId>/
  ├─ operation.json       (metadata, status, lease)
  ├─ events.jsonl         (append-only event stream — what happened, for replay/UI)
  ├─ checkpoint.json      (structured resume state — written at every safe boundary)
  ├─ context-pack.json    (the snapshot the worker received at start)
  └─ artifacts/           (any files the op produced for review)
```

`checkpoint.json` schema:
```ts
interface OpCheckpoint {
  opId: string;
  updatedAt: string;
  plan: PlanStep[];                  // the worker's working plan
  completedSteps: number;            // index into plan
  worktreeBranch: string | null;     // if the op uses a worktree
  lastCommitSha: string | null;      // last good commit on the op branch
  changedFiles: string[];            // running tally
  pendingInstructions: string[];     // injected via redirect, not yet consumed
  providerUsed: string;              // which provider ID handled this
  retryCount: number;                // how many times this op has been respawned
  lastSafeBoundary: {                // the most recent point we could resume from
    label: string;                   // "after-write-of-x", "post-build", etc.
    timestamp: string;
  };
}
```

Workers write checkpoints at **safe boundaries** — after a tool call commits, after a build passes, after a phase ends. The supervisor reads `checkpoint.json` (not events.jsonl) when reassigning a recovered op. Events provide audit trail and UI replay; checkpoints provide resume state.

If the UI reloads, the op panel reconstructs visuals from `events.jsonl`. If the worker crashes, the supervisor reads `checkpoint.json` to decide where to resume. If the user opens a new browser tab, they can subscribe to the live tail of an in-progress op.

**WS streaming and disk-append run in parallel** — disk is the source of truth, WS is the optimistic delivery channel.

**Redaction at write time.** The disk log is a long-term artifact; secrets must never reach it. A redactor runs over every event before disk-append, scrubbing:
- Authorization headers, Bearer tokens, API keys, OAuth tokens
- Browser autofill values that hit `browser_fill_from_secret`
- Tool outputs explicitly tagged `sensitive: true`
- Anything matching the secret-name patterns from `~/.lax/secrets.enc`

Redaction is fail-closed: if the redactor isn't sure, it redacts. The original (un-redacted) event still streams to the live UI session via WS, but only the redacted form is persisted.

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

## 7. Interrupt semantics — three distinct controls (preemption is cooperative)

"Stop" alone is ambiguous. Define three, with explicit semantics about WHEN they take effect:

| Control | Effect | Cooperative or immediate? | When to use |
|---|---|---|---|
| **Pause** | Worker finishes its current safe boundary (a tool call commits, a build completes), then waits. Op is resumable from the checkpoint. | **Cooperative** — applies at the next safe step boundary, not mid-tool-call or mid-model-call. May take 30s-5min to land depending on what's in flight. | "Hold on, let me look at what you've done so far." |
| **Redirect** | Injects new instruction into the worker's context for the next iteration. Op continues without pausing. | **Cooperative** — the worker reads `pendingInstructions` at the next iteration boundary. | "Also add a stop-loss strategy." |
| **Kill** | SIGKILL the worker, mark op as cancelled. Not resumable. Any in-progress side effects may leave artifacts. | **Immediate** — only Kill stops work right now. | "This is going off the rails, kill it." |

Each maps to a distinct API endpoint and UI affordance. Voice agent has tools for all three.

**Why cooperative for Pause/Redirect:** stopping mid-model-call wastes the in-flight tokens; stopping mid-tool-call may leave half-written files. The worker checks for pending controls at every safe boundary (the same boundaries where it writes checkpoints). User-facing UI tells the truth: "Pause requested — will land after the current step (~30s-2min)."

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

## 11. Centralized tool safety (no worker-only shortcut)

Workers MUST call tools through the same `tool-executor` / `tool-policy` / approval gate / SecurityLayer path as the main agent. There is no worker-only shortcut. The ari-kernel, the protected-files guard, the egress allowlist, the secret approval flow — all of it applies in worker context too.

**Why:** the worker boundary is for resource isolation (heap, memory, parallelism). It is NOT a security boundary. A worker that gets compromised, gets prompt-injected, or just makes a mistake must hit the same guardrails as the main agent. Anything else creates a "bypass via delegation" pattern.

Implementation: workers call back to the parent over IPC for tool approval decisions and for execution of any tool whose result the parent needs to track. Cheap read-only tools (read, glob, grep) can execute worker-local for latency, but write/edit/bash/http_request always go through the parent's approval+exec path.

## 12. Secrets do not enter context packs

Context packs are written to disk (`context-pack.json`), passed across IPC, and visible in the events log. Therefore:

- **Never** include raw secret values (API keys, OAuth tokens, passwords)
- **Allowed**: secret NAMES (`openai_api_key`), placeholders (`${SECRET:openai_api_key}`), and access grants (a list of which secrets the worker is permitted to request)
- Workers fetch actual values via the existing `request_secret` / `secret_get` tools at the moment of use
- The parent's approval gate (`request_secret`) still mediates, even when called from a worker

Pattern:
```
context-pack.json (worker sees this):
  secrets: { allowed: ["openai_api_key", "kraken_api_key"] }

Worker code:
  const key = await tools.request_secret({ name: "kraken_api_key" });
```

Result: even if a context-pack file leaks (disk theft, log scrape, accidental commit), no live credentials are exposed.

## 13. Dynamic provider concurrency

Static `maxConcurrent` is the starting baseline. The supervisor adjusts it dynamically:

- On HTTP 429 (rate-limited) or 529/503 (overloaded): halve the provider's effective concurrency, set a 60s cooldown
- On three consecutive successes after cooldown: ramp concurrency back up by 1
- Recover to declared `maxConcurrent` over time, never exceeds it
- Per-provider cooldown state visible in `/api/health/providers`

This handles bursty usage gracefully — the system slows down rather than failing, and users see "queued" instead of "error: 429."

## 14. Local models need a GPU semaphore

Worker count is NOT local-model concurrency. A 7B model on a single 3060 fits one generation comfortably; two would OOM the GPU. So workers using local models share a **resource lock**:

```ts
interface Op {
  ...
  resourceLocks: string[]; // ["gpu:0"] for ops needing the local GPU
}
```

The supervisor's dispatcher won't assign an op to a worker if the op's required `resourceLocks` are held by another running op. Multiple GPUs on the same machine = multiple semaphores (`gpu:0`, `gpu:1`).

For ops that don't need the GPU (HTTP-only providers), `resourceLocks: []` — no contention, full parallelism.

## 15. Interactive lane refinement

**Not every chat message consumes a worker.** The supervisor (main agent) answers lightweight questions directly:
- "What did you do yesterday?" → memory query, direct response
- "Show me the last cron report" → file read, direct response
- "Pause the kraken build" → control plane action, direct response

The interactive lane is for **heavy interactive work** — the user is waiting on a screen AND the work needs a tool-using sub-agent (e.g. "diagnose why this endpoint returns 500 — investigate now"). Then we burn an interactive worker.

Heuristic: if the supervisor can answer in <1 model call with no tools, it does so directly. Otherwise it delegates to the interactive lane.

This keeps the worker pool from being burned on trivial questions while still guaranteeing interactive priority for genuinely-interactive heavy work.

## 16. Cross-session visibility — privacy scoping

Today's deployment is single-user, single-machine. Ops are user-scoped (i.e. all visible to the local user). When this evolves toward team/cloud:

- Ops carry an `ownerId` (user) and optional `projectId`/`orgId`
- Cross-session subscription requires permission match (you can only watch ops you own OR ops in projects you have access to)
- Voice + browser tabs of the same user → unrestricted shared visibility (today's behavior)
- Foreign user → no visibility unless explicitly shared

For now: implement `ownerId` in the op metadata even though there's only one user. Avoids a painful retrofit later.

## 17. IPC protocol versioning

Every message between supervisor and worker carries a `protocolVersion`:

```ts
interface IpcMessage {
  protocolVersion: 1;
  type: "task-assign" | "heartbeat" | "event" | "checkpoint" | "result" | "control";
  ...
}
```

When the parent code is upgraded (new server start) but a worker process from before the upgrade is still alive, the parent sees the old `protocolVersion` and either:
- Talks the old dialect (if compatible), or
- Recycles the worker (forcing a fresh worker on the new version)

Saves a class of "they updated the parent but workers are on the old IPC" subtle bugs. Bump the version any time the message shape changes.

## 18. Failure retry policy — bounded recovery

"Recoverable" must not mean "retry forever." Every op carries:

```ts
interface OpRetryPolicy {
  maxRecoveryAttempts: number;       // default 3
  backoffMs: number[];               // [5000, 30000, 120000]
  lastFailureReason: string | null;
  lastFailureAt: string | null;
  attemptCount: number;
}
```

After `maxRecoveryAttempts`, the op is marked `failed-permanently`. The user gets the failure reason + the durable event log + the checkpoint. Retry button is on them.

Without this cap, "doesn't give up" silently becomes "burns time/tokens forever" on a genuinely unrecoverable failure.

## 19. Worktree collision — the merge/rebase reality

Per-op worktrees prevent live-file races (two workers can't write the same file at once because they're in different filesystem dirs). But two workers can still touch the same files, and at merge time those changes need to reconcile.

When an op finishes successfully:
- Its worktree branch holds N commits
- Before merging to base, the supervisor runs `git merge --no-commit --no-ff <op-branch>` in a probe checkout
- If it cleanly merges → fast-forward or merge commit, op marked complete
- If it conflicts → op marked `merge-conflict-pending`, surfaced to user with the conflicting files listed
- User decides: accept op A's version, accept op B's version, or manually resolve

The summary panel for an op should flag *anticipated* conflicts BEFORE the user reviews — "This op modified `src/cron-service.ts`; another op touched the same file. Likely conflict." Saves the user from being surprised at merge time.

Two ops touching truly orthogonal files (different dirs entirely) merge cleanly always. The conflict story is a fallback for the rarer overlap case.

## 20. Provider fallback — only safe before side effects

> Earlier draft said: "Provider goes down → capability matrix routes to fallback provider"
> That's a footgun. After a side-effecting tool call (email send, payment, file write, HTTP POST/PUT/DELETE), naive fallback can double-send or double-mutate. Refined rule:

**Provider fallback is allowed only:**
- Before any side-effecting tool call has executed in the current op, OR
- After a checkpoint proves the next step is idempotent (e.g. read-only research, math)

Implementation:
- Each tool declares `sideEffecting: boolean` (already exists in `committing-tool-check.ts`)
- The supervisor tracks "has this op committed any side-effecting calls yet?"
- If yes AND the provider fails → mark `failed-needs-human`, don't fallback
- If no → fallback transparently to the next provider in the capability-matched list

This is the same rule chat.ts already uses for empty-response auto-failover (`suppressFailover` when `committingCalls.length > 0`). Generalize it across all worker→provider routing.

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
| 9 | **Checkpoint writer + redactor + IPC versioning** (cuts across 1-7) | wired into 1 | Resume-on-restart, secrets never on disk, upgrade-safe IPC |
| 10 | **GPU semaphore + dynamic provider concurrency + retry caps** | 4h | Local-model use, graceful degradation, no infinite-burn |
| 11 | **Worktree merge-conflict surfacing** | 2-3h | User sees collisions before review |

Total: ~35-50 hours of focused work for the full vision. Step 0 is shipping today; step 1 is the load-bearing one — once it's right, everything else is parameter scaling. Steps 9-11 are the supervisor-contract additions that turn "workers exist" into "system doesn't break or give up."

## What this guarantees

| Failure mode | Without supervisor contract | With it |
|---|---|---|
| Worker OOMs mid-op | UI dead, all sessions affected | Worker dies, supervisor recycles, op resumed from durable log |
| Worker hangs (silent infinite loop) | User waits forever | Heartbeat misses → killed → op marked recoverable → retried |
| User wants to redirect mid-build | No way to inject | Redirect endpoint pushes new instruction to live worker |
| Long build starves chat | Chat unresponsive | Reserved interactive slot guarantees chat path |
| Browser reloads mid-op | Op state lost from UI | Event log replayed, op panel reconstructs |
| Provider goes down (no side effects yet) | All workers fail | Capability matrix routes to fallback provider, lease reassigned |
| Provider goes down (after side-effecting call) | Naive retry double-mutates | `failed-needs-human` — user decides whether the side-effect landed |
| Two ops both want same files | Race condition / corruption | Per-op worktree (existing pattern), no collision |
| User says "stop" ambiguously | Pick one interpretation, often wrong | Three explicit controls, user picks Pause / Redirect / Kill |

The system that doesn't break or give up isn't one mechanism — it's the composition. The worker pool gives you the muscle, the supervisor contract gives you the guarantees.
