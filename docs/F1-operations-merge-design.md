# F1 — Merging the forked delegation engine `src/operations/` into canonical `src/ops/`

**Status:** Design doc only. No `src/` files edited. No commit.
**Date:** 2026-06-29
**Author:** investigation pass (read-only)

---

## 0. TL;DR

`src/operations/` is a **dormant, self-contained fork** that predates the mature `src/ops/`
worker-lease engine. The two have **different data models** (`Operation`/`OperationPhase` vs
`Op`/`ContextPack`), **different execution models** (a standalone fire-and-forget `startExecutor`
loop vs the canonical-loop worker-lease pool), and **different on-disk locations**.

A full merge is **advisable but not urgent** — and the highest-value finding here is that it
should be **scoped down**. Only two pieces of `src/operations/` are actually load-bearing today:

1. The **secret pre-blessing privacy gate** consumed by `src/browser/secret-fill.ts`.
2. The **`Operation` type** that `src/autopilot/*` reuses purely as a persistence container.

Everything else in `src/operations/` (the conductor state machine, the autonomous executor,
the LLM goal→phase decomposer, the 5 `operation_*` tools) is **functionally superseded** by
`src/ops/` + the canonical loop, and is dormant — `src/operations/` was last touched 2026-06-11;
its core (`conductor.ts`/`executor.ts`) on 2026-06-06.

**The single biggest risk** is the **privacy gate migration**: `getActivePreBlessedSecrets` +
`loadOperation` are the only runtime path by which a `{secret, origin}` first-use approval gets
auto-satisfied. Moving pre-blessing into the canonical model without weakening that gate is the
crux of the whole effort. **And I found a latent correctness bug right now**: `secret-fill.ts`
reads operations from `process.cwd()/workspace/operations`, but the conductor writes them to
`getRuntimeConfig().workspace/operations`. Those are **different directories** on the installed
app — meaning **pre-blessing via `operation_start` is very likely already silently broken** (the
gate can't find the op to read `preBlessedSecrets`). The merge fixes this by routing through one
canonical store, but it must be called out as a pre-existing live defect, not a merge regression.

**Two decisions handed back to the user** (product/taste calls, not engineering):
- **Tool taxonomy**: keep `operation_start` as a thin shim over ops, or remove it from the
  delegation picker and fold multi-phase semantics into `op_submit_async`/`agent_spawn`?
- **Decomposer**: keep the LLM goal→phase decomposer as a capability (port onto the ContextPack
  builder), or drop it?

---

## 1. Side-by-side: what each subsystem owns

### 1.1 Inventory / liveness

| | `src/operations/` (the FORK) | `src/ops/` (CANONICAL) |
|---|---|---|
| LOC | ~1,249 (incl. 1 test) | ~2,739 (incl. tools/ + 2 tests) |
| Last touched | 2026-06-11 (core: 2026-06-06) | 2026-06-28 (active) |
| Wired into canonical-loop | **No** — runs its own loop | **Yes** — worker pool, lease, session bridge |
| Live consumers | secret-fill (runtime), autopilot (types only), `operation_*` tools | op_submit_async, delegation handoff, autopilot store coexistence |
| Files | conductor, executor, decomposer, tools, types | types, op-store, context-pack-builder, session-bridge, action-ledger, redactor, event-log, checkpoint, heartbeat, idle-nudge, pending-notifications, provider-matrix, tools/* |

### 1.2 Data models

**`src/operations/types.ts` — `Operation` / `OperationPhase`**
- `Operation` = `{ id, goal, summary, phases[], status, currentPhase, sharedState, events[],
  preBlessedSecrets?, autopilot?, autopilotRounds? }`.
- `OperationPhase` = `{ id, name, goal, successCriteria[], suggestedTools[], protocolName,
  status, attempts, lastError, output }`.
- **Model is phase-centric**: an operation is an ordered list of phases, each a mini-goal with
  success criteria and a retry counter. `sharedState` carries cross-phase outputs forward.
- Status enum: `pending | running | paused | completed | failed | cancelled`.

**`src/ops/types.ts` — `Op` / `ContextPack`**
- `Op` = `{ id, type, task, contextPack, lane, retryPolicy, ownerId, visibility, status,
  createdAt, workerId, attemptCount, model?, appUrl?, canonical?, … }`.
- `ContextPack` = the pre-baked payload a worker spawns with: `{ task{description,
  successCriteria, constraints, notWhatToRedo}, context{recentTurns, referencedFiles,
  memoryHits, agentsRules}, capabilities, budget, routing{lane, preferredProvider, authSource},
  secrets{allowed[]} }`.
- **Model is delegation-centric**: one Op = one delegated unit of work handed to one worker.
  No native concept of multi-phase sequencing — multi-step is expressed by the worker's own
  internal plan (`OpCheckpoint.plan: PlanStep[]`) or by submitting multiple ops.
- Status enum is a **superset**: adds `needs-input` and `merge-conflict-pending`; otherwise
  the names align (`pending/running/paused/completed/failed/cancelled`).

**Key structural difference:** `Operation.phases[]` (first-class ordered phases, each
independently retried + checkpointed to disk) has **no direct equivalent** in `Op`. The
nearest analogue is `OpCheckpoint.plan: PlanStep[]`, but that is *worker-internal resume state*,
not a supervisor-orchestrated phase machine. **This is the real semantic gap** between the two
systems and the thing the taxonomy/decomposer decisions hinge on.

`ContextPack.secrets.allowed[]` is **names-only** ("never values, §12") — structurally the right
home for pre-blessing (see §2.4), but its **current semantics are "names the worker may read
from the vault," not "names whose first-use origin gate is pre-satisfied."** Those are not the
same grant. Conflating them would *widen* the gate. See §2 for the precise distinction.

### 1.3 Execution models

**`src/operations/executor.ts` — standalone fire-and-forget loop**
- `operation_start` tool → `createOperation()` (decompose) → `startExecutor(opId)` returns
  immediately.
- `runExecutorLoop` (background IIFE): get next pending phase → `spawnPhaseAgent()` via
  `invokeDefinition` (a *separate* invoke path, not the canonical worker pool) → wait on
  `EventBus "handler:agent-result"` → parse a mandatory `PHASE_RESULT:` marker line →
  `markPhaseCompleted` / `markPhaseFailed` / `pauseOperation`.
- Concurrency: hard-coded sequential (1 phase at a time), `MAX_ITERATIONS = 50`,
  15-min per-phase timeout.
- Liveness probe: `awaitOperationStarted` polls the **disk file** every 100ms (ops have no
  in-memory table here — "Operations do NOT flow through the canonical-loop ops table").
- Cancellation: in-process `activeExecutors: Map<id, AbortController>`. **Lost on restart** —
  there is no resume-on-boot wiring; a crashed app abandons in-flight executors (the disk
  state survives but nothing re-drives it).

**`src/ops/` + canonical-loop — worker-lease pool**
- `op_submit_async` → `buildOpFromArgs` → `canonicalLoopEntry(op)` → scheduler leases the op to
  a worker slot (lane-capped) → `awaitOpRunning` probes the **in-memory ops table** for the
  `running` transition.
- Lifecycle events (`started/phase/tool_call/.../completed`) stream worker→supervisor→
  subscribers and are **disked through the redactor** (`src/ops/redactor.ts`,
  `event-log.ts`).
- Session routing via `src/ops/session-bridge.ts` (op↔session map, completion notifications,
  voice-proactive speak).
- Dedup/guard stack in `op-submit-async.ts` (live-peer block, 30s window, casual-reply guard,
  task-similarity guard) — none of which `operation_start` has.
- Persistence + status via `op-store.ts` (atomic tmp+rename, `mode: 0o600`), pruning via
  `pruneOldOps`.

**The fork reinvents, at lower fidelity:** its own loop, its own liveness probe, its own
result-parsing protocol (`PHASE_RESULT:` text marker — brittle vs canonical structured events),
its own disk format, its own cancellation registry, and a *separate* sub-agent invoke path
(`invokeDefinition` directly rather than the leased worker). The canonical engine does all of
this with redaction, dedup, lane scheduling, and session routing the fork lacks.

### 1.4 Persistence — **three colliding `operations` directories (live defect)**

This is the most important concrete finding. Four code paths reference an `operations` dir,
and they **do not agree**:

| Writer / reader | Path it uses | Resolves to (installed app) |
|---|---|---|
| `src/ops/op-store.ts` `OPS_BASE` | `getLaxDir()/operations` | `~/.lax/operations` |
| autopilot caller `server/index.ts:204` + `routes/autopilot.ts:40` | `join(dataDir, "operations")` where `dataDir == getLaxDir()` | `~/.lax/operations` ← **same as ops** |
| `src/operations/conductor.ts` `defaultOperationsDir()` | `getRuntimeConfig().workspace/operations` | `~/Documents/Local Agent X/workspace/operations` (workspace is migrated to ~/Documents) |
| `src/browser/secret-fill.ts:53` `operationsWorkspace()` | `process.cwd()/workspace/operations` | depends on cwd of the server process — **neither of the above** |

Consequences:
- **Autopilot `Operation` JSON already lands in `~/.lax/operations` alongside canonical `Op`
  JSON.** `op-store.ts:listOps()` already reads both and defensively coerces (`op-store.ts:70`
  comment: "at least one writer persists createdAt as a number — autopilot `op_ap_*`"). So the
  two shapes *already coexist in one directory* — the merge formalizes what is already true.
- **`operation_start` (conductor) writes somewhere ELSE** (`workspace/operations`), and
  **secret-fill reads from a THIRD place** (`cwd/workspace/operations`). On the installed app
  these are different directories, so **`getActivePreBlessedSecrets` very likely cannot find
  the op it needs to read `preBlessedSecrets` from** → pre-blessing silently fails closed
  (gate denies, asks for approval). Fails *safe* (deny), but it means the documented
  unattended-overnight pre-bless feature is **probably already non-functional**. This must be
  flagged as a pre-existing bug, and the merge's "one canonical store" outcome is its fix.

---

## 2. The privacy gate migration (HIGHEST RISK)

### 2.1 How pre-blessing works today (exact call chain)

`browser_fill_from_secret` (`secret-fill.ts`) enforces a 5-guardrail ladder. Guardrail 3 is the
**approval ladder** (lines 219–242):

```
sameSession  = meta.createdBySession === sessionId            // this session captured it
userApproved = secretsStore.isFillApproved(name, currentOrigin) // persisted vault approval
preBlessed   = getActivePreBlessedSecrets(loadOpForPreBless).has(name)  // ← the operations hook
gateOutcome  = sameSession ? "session"
             : userApproved ? "approved"
             : preBlessed   ? "pre_bless"
             : "denied"
```

The `preBlessed` branch is the **only** coupling to `src/operations/`:

- `getActivePreBlessedSecrets(loadFn)` (`executor.ts:153`) iterates `activeExecutors.keys()`
  (the in-memory set of **currently-running** operation ids), calls `loadFn(opId)` for each,
  and unions every op's `preBlessedSecrets[]` into a `Set<string>`.
- `loadOpForPreBless(opId)` (`secret-fill.ts:56`) calls `loadOperation(operationsWorkspace(),
  opId)` and returns `{ preBlessedSecrets }`.

So the runtime contract is: **a `{secret, origin}` first-use is auto-approved (`pre_bless`) iff
the secret name appears in the `preBlessedSecrets[]` of at least one operation that is
*currently running* (alive in `activeExecutors`).** Origin binding (guardrail 2) is enforced
*before* this and is **not** overridden by pre-bless — a pre-blessed secret still cannot fill on
a different origin than the one it's bound to.

`preBlessedSecrets[]` is seeded once, at `operation_start`, from the `pre_blessed_secrets` tool
arg the **user must pass explicitly** (`tools.ts:48`; the description forbids the model from
inferring it).

### 2.2 The security invariant that must NOT weaken

> **INVARIANT (must hold identically post-merge):** First use of a given `{secret, origin}`
> pair requires explicit user action — *unless* one of: (a) this session captured the secret,
> (b) the user saved a per-origin approval in the vault, or (c) the user pre-blessed the secret
> name **for a currently-live operation**. Pre-bless is **scoped to the lifetime of the op that
> carries it** and **never overrides origin binding**.

Two sub-properties that are easy to lose in a port and must be preserved:

- **Liveness scoping.** `getActivePreBlessedSecrets` only unions ops in `activeExecutors`
  (running). A *completed/cancelled/failed* op's pre-bless must NOT keep auto-approving. If the
  port naively unions over all ops on disk (e.g. every `Op` whose `contextPack.secrets` lists
  the name), pre-bless would persist forever — a **silent widening**. The new query MUST filter
  to live ops only.
- **Names-only, never values.** `ContextPack.secrets.allowed` is names-only by spec. The gate
  must continue to fetch the value at the last moment from `secretsStore.get()` (guardrail
  ordering at `secret-fill.ts:244`), never from the op/pack.

### 2.3 Distinguish "may read" from "first-use pre-approved" — DO NOT CONFLATE

`ContextPack.secrets.allowed[]` today means *"names the worker is allowed to read from the
vault"* (an allow-list for the worker's runtime). `preBlessedSecrets[]` means *"first-use origin
gate is pre-satisfied for these names."* **These are different grants** and collapsing them
would widen the gate: a worker that's merely *allowed to read* a secret would suddenly *also*
bypass the first-use origin approval. The migration must keep them as **two distinct fields**,
not reuse one for the other.

### 2.4 The migration plan (do NOT widen the surface)

**Recommended shape:** add a dedicated, explicit field to `ContextPack` and a single canonical
query function; keep the gate logic in `secret-fill.ts` byte-for-byte the same except for the
data source.

1. **Extend the canonical model with a *separate* pre-bless field** (not `secrets.allowed`):
   ```ts
   // src/ops/types.ts — ContextPack.secrets
   secrets: {
     allowed: string[];            // existing: names the worker may READ
     preBlessed?: string[];        // NEW: names whose first-use origin gate is pre-satisfied
   }
   ```
   Seed `preBlessed` *only* from an explicit user-supplied arg, exactly like
   `operation_start.pre_blessed_secrets` does today (same "never infer" rule in the tool desc).

2. **Add one canonical query in `src/ops/`** (e.g. `op-store.ts` or a small `pre-bless.ts`):
   ```ts
   // Union preBlessed names across LIVE ops only. Liveness = the in-memory
   // running set (worker pool / canonical-loop ops table), NOT all-ops-on-disk.
   export function getActivePreBlessedSecrets(): Set<string>
   ```
   Liveness source MUST be the canonical "is this op running" signal (the in-memory ops table /
   worker registry the scheduler already maintains), so the scoping invariant in §2.2 holds.
   This replaces `operations/executor.getActivePreBlessedSecrets` + the `activeExecutors` set.

3. **Repoint `secret-fill.ts`** (the ONE consumer):
   - Delete imports of `../operations/executor.js` and `../operations/conductor.js`.
   - Delete `operationsWorkspace()` and `loadOpForPreBless()` (the broken `cwd`-relative path).
   - Replace `getActivePreBlessedSecrets(loadOpForPreBless).has(name)` with the new canonical
     `getActivePreBlessedSecrets().has(name)`.
   - **Everything else in the file stays identical** — the 5 guardrails, the audit rows, the
     gate-outcome strings (`"pre_bless"` etc.) do not change. This keeps the blast radius to one
     line of *logic* + import surgery.

4. **Seed pre-bless from whichever submit path survives the taxonomy decision** (§4):
   - If `operation_start` stays as a shim, it forwards `pre_blessed_secrets` into the op's
     `contextPack.secrets.preBlessed`.
   - If it's removed, `op_submit_async` / `agent_spawn` gain an optional `pre_blessed_secrets`
     arg (same explicit-only semantics) wired into `buildOpFromArgs`.

**Why this fixes the live defect:** both writer and reader now go through one canonical store +
one in-memory liveness signal. The `process.cwd()` vs `workspace` vs `~/.lax` divergence
(§1.4) disappears because there is exactly one path.

### 2.5 Tests this chunk MUST add (gate is security-critical)

- **Cross-seam contract test** (template: the existing `attachment-read-contract.test.ts`
  referenced in MEMORY): a `{secret, origin}` first-use is denied with NO live pre-bless;
  allowed with a live pre-blessed op; **denied again once that op reaches a terminal state**
  (liveness scoping). This last assertion is the regression guard for the §2.2 widening risk.
- Origin-binding still wins: a pre-blessed secret on the *wrong* origin is still blocked.
- "may read" ≠ "pre-approved": an op with the name in `secrets.allowed` but NOT in
  `secrets.preBlessed` does **not** auto-satisfy first-use.

---

## 3. Persistence / autopilot cutover

### 3.1 What autopilot actually uses

Autopilot imports **types only** — there is no runtime dependency on the conductor/executor:
- `loop.ts:11` — `import type { Operation }`
- `start.ts:21` — `import type { Operation }`
- `round-agent.ts:11` — `import type { Operation, OperationPhase }` (and immediately parks them:
  `type _UnusedRefs = Operation | OperationPhase;` — a lint pacifier, line 181)

Autopilot **constructs `Operation` by hand** (`start.ts:199`), explicitly bypassing the
conductor: *"Construct Operation manually — bypass conductor.createOperation to skip phase
decomposition. Operation is just our persistence container here."* It sets `phases: []`,
`autopilot: <config>`, `autopilotRounds: []`, then writes `operation.json` directly into
`join(deps.workspaceDir, op.id)` where `deps.workspaceDir == ~/.lax/operations`. The loop
(`loop.ts`) maintains its own in-memory `activeOps` registry and re-persists via `persistOp`.

**So `Operation` is, for autopilot, a JSON container with these fields used:** `id, goal,
summary, phases (empty), status, createdAt, startedAt, currentPhase, sharedState, events[],
autopilot, autopilotRounds`. The phase machinery (`OperationPhase`, `currentPhase` advancement,
`successCriteria`) is **never exercised** by autopilot.

### 3.2 Can the type be aliased / kept?

**Yes — and this is the low-risk path.** Three options, in order of preference:

- **Option A (recommended): keep `Operation`/`OperationPhase` as a small autopilot-owned type.**
  Move `src/operations/types.ts` → `src/autopilot/operation-types.ts` (or inline into
  `autopilot/types.ts`) and repoint autopilot's three `import type` lines. This *severs the last
  type coupling to the fork* with zero on-disk migration: autopilot keeps writing the same JSON
  to the same `~/.lax/operations` dir. `op-store.listOps()` already tolerates these records
  (the `op_ap_*` coercion). **Nothing on disk changes; no in-flight migration needed.**
  This makes `src/operations/types.ts` deletable.

- **Option B: model autopilot as a canonical `Op`.** Represent an autopilot run as an `Op` with
  `type: "autopilot"` and stash rounds in a sidecar. Higher fidelity (unifies the store), but it
  rewrites autopilot's persistence + status surface and is **not required** to delete the fork.
  Defer to a later, separate effort if desired — it's an autopilot refactor, not part of F1.

- **Option C: do nothing to autopilot, just stop the cross-package import.** Re-export the type
  from a neutral location. Functionally equals A.

**Recommendation: Option A.** It's the minimal cut that lets `src/operations/` be deleted.

### 3.3 On-disk migration for `operation_start` ops (the conductor's `op_*` dirs)

Conductor-written ops live at `workspace/operations/op_*/{operation.json, plan.md,
phase-N.log}`. These are **separate** from `~/.lax/operations`. Migration question hinges on the
taxonomy decision (§4):

- **If `operation_start` becomes a shim over `op_submit_async`/canonical ops:** new operations
  no longer write the conductor format at all. **In-flight conductor operations at upgrade time
  are the only migration concern.** Given the executor has **no resume-on-boot** (§1.3) — a
  restart already abandons in-flight conductor ops (disk state orphaned, nothing re-drives it) —
  the practical migration is:
  1. On upgrade, **do not auto-migrate** old `workspace/operations/op_*` dirs (they're already
     dead on restart). Leave them on disk as inert artifacts (plan.md is still human-readable).
  2. `operation_list`/`operation_status` (if kept) read from the canonical store going forward;
     optionally also list legacy dirs read-only for history.
  3. Prune legacy dirs via the existing `pruneOldOps` mechanism or a one-time sweep.
- **If `operation_start` is removed entirely:** same as above, plus drop the tool. No new
  conductor writes ever happen.

**In-flight behavior on upgrade (state the truth to the user):** any operation that was
"running" in the old executor is **not resumable** today regardless of the merge — the executor
already loses its `activeExecutors` AbortController on restart and never re-drives disk state.
So the merge does not *introduce* in-flight loss; it inherits an existing limitation. The honest
upgrade note is: "in-flight operations from before the update will not resume (this was already
true); start them again."

---

## 4. DECISION 1 — Tool taxonomy (USER'S PRODUCT CALL — options only, not decided here)

Today the delegation picker presents the model **three** primitives, explicitly distinguished:
- `agents/tools.ts:95`: "*for a multi-phase goal that needs decomposition, use `operation_start`*"
- `op-submit-async.ts:29` DELEGATION PICKER: "*`op_submit_async` = ONE background task …
  `operation_start` = a multi-PHASE goal needing decomposition + checkpoints … `agent_spawn` =
  hand work to a NAMED catalog agent/role.*"

So `operation_start`'s *advertised* differentiator is **"multi-phase decomposition + checkpoints."**
The canonical engine has no first-class phase machine (§1.2), so removing `operation_start`
removes that advertised capability unless something replaces it.

### Option 4A — Keep `operation_start` as a thin shim over canonical ops
`operation_start` stays in the picker but its body becomes: decompose (if §5 kept) →
build ContextPack(s) → submit through canonical `op_submit_async` path → return opId.
- **Model-facing pros:** the picker's mental model is unchanged; the model keeps a clear verb
  for "big multi-step goal." Backward-compatible with the system prompt + memory + every doc
  that mentions `operation_start`. Pre-bless seeding has an obvious home.
- **Model-facing cons:** preserves a 3rd delegation verb the model must disambiguate (the
  picker already has to teach the op_submit/operation/agent_spawn distinction — empirically a
  source of mis-selection). The "multi-phase" promise must be made true on the canonical engine
  (phases as sequential ops, or as worker-internal plan steps).

### Option 4B — Remove `operation_start`; fold multi-phase into `op_submit_async` / `agent_spawn`
Delete the `operation_*` tools (or alias to `op_*`), drop the picker line, and let the model
express multi-step work either as (a) one `op_submit_async` whose worker plans its own steps via
`OpCheckpoint.plan`, or (b) several dependent ops.
- **Model-facing pros:** **two** delegation verbs instead of three — strictly simpler picker,
  fewer mis-selections; one execution engine to reason about; matches MEMORY's "fix the signal,
  not the structure / don't add a 2nd system" doctrine. The canonical engine already does
  checkpoints + retries + dedup + session routing better than the fork.
- **Model-facing cons:** loses the explicit "decompose this big goal into ordered phases"
  affordance. Worker-internal planning (`PlanStep[]`) is *resume state*, not supervisor-visible
  phase orchestration, so the user-visible "phase 3/7" progress UI the conductor produced goes
  away unless rebuilt. Every prompt/doc/memory mentioning `operation_start` must be updated
  (non-trivial doc surface). Risk of breaking a model habit baked into the system prompt.

**This is a product/taste call** (how many delegation verbs to expose, whether visible phase
progress is a feature worth keeping) — handed to the user. Engineering-neutral note: 4B is the
cleaner end-state and aligns with the "don't keep a parallel system" doctrine, but 4A is the
lower-risk intermediate that can be shipped first and collapsed to 4B later.

---

## 5. DECISION 2 — The LLM goal→phase decomposer (USER'S PRODUCT CALL)

`src/operations/decomposer.ts` is a capability `src/ops/` **does not have**: a single LLM call
that turns a free-text goal into an ordered, measurable phase plan (`{summary, phases[]}` with
per-phase `successCriteria`, `suggestedTools`, optional `protocolName`). It runs on the user's
configured provider via `dispatch`, `rejectOAuth: true` (a CLI subscription can't serve bulk
JSON planning), temperature 0.3, with robust fence/brace-carving JSON parsing and a single
ad-hoc-phase fallback if the LLM is unavailable.

### Option 5A — Keep it (port onto the ContextPack builder)
Lift `decomposeGoal()` into `src/ops/` (e.g. alongside `context-pack-builder.ts`). The surviving
submit path optionally calls it to expand a one-line goal into `successCriteria`/structured
constraints, *or* into a sequence of dependent ops.
- **Kept:** automatic goal→structure expansion (better than a bare "build the kraken bot"
  delegation — exactly the quality gap the ContextPack builder doc complains about); the
  protocol-matching hook; the visible plan for the user.
- **Cost:** ~154 LOC to port + a test; the decomposer's output schema must be mapped onto
  ContextPack/Op (phases → either ordered ops or `successCriteria`). It's an extra LLM call on
  the submit path (latency + a small spend).

### Option 5B — Drop it
- **What is lost:** the *only* automatic goal-decomposition in the codebase. Multi-step goals
  fall back to "the worker figures out its own plan at runtime" (no pre-baked phase plan, no
  pre-computed per-phase success criteria, no protocol pre-matching, no user-facing plan
  preview). For genuinely large goals this is a real capability regression — the worker starts
  colder. For most delegations (already single-task) it's a no-op.
- **Gained:** ~150 LOC and one LLM call deleted; simpler submit path.

**Coupling to Decision 1:** if 4B (remove `operation_start`) is chosen, the decomposer loses its
natural caller and 5B becomes the path of least resistance — but the *capability* could still be
ported onto `op_submit_async` as an opt-in `decompose: true`. If 4A (shim) is chosen, 5A is the
natural pairing (the shim decomposes then submits). **Recommend deciding 4 and 5 together.**

---

## 6. Chunk plan for the merge (atomic, seam-anchored, reversible, risk-ordered)

Each chunk is independently shippable, independently revertible, and gated by `npm run build`
(the 400-LOC hygiene + no-require gate, per MEMORY — `tsc --noEmit` is insufficient). Ordered
**lowest-risk first** so the dangerous gate migration lands on a de-risked base.

| # | Chunk | Touches | Risk | Autonomy |
|---|---|---|---|---|
| **C1** | **Fix the live path-divergence bug** in `secret-fill.ts` (point reader at the SAME dir the conductor writes). Optional pre-merge hotfix that makes pre-bless work again *before* any refactor. Pure bugfix + regression test. | `secret-fill.ts` (1 path) + test | **Low** (fixes a fail-safe defect) | **Safe-autonomous** |
| **C2** | **Sever autopilot's type coupling** (Decision-independent). Move `Operation`/`OperationPhase` into autopilot (Option 3.2-A), repoint 3 `import type` lines. No disk change. | `autopilot/{loop,start,round-agent}.ts`, new `autopilot/operation-types.ts` | **Low** | **Safe-autonomous** |
| **C3** | **Add canonical pre-bless plumbing** (no consumer cutover yet): add `ContextPack.secrets.preBlessed?` + canonical `getActivePreBlessedSecrets()` querying the live-ops table. Pure additive; nothing reads it yet. Unit test for liveness scoping. | `ops/types.ts`, `ops/op-store.ts` (or `ops/pre-bless.ts`) | **Low-med** (additive) | **Safe-autonomous** |
| **C4** | **Cut `secret-fill.ts` over to canonical pre-bless** + ship the cross-seam contract test (§2.5). Delete the two `../operations/*` imports + the `cwd`-relative helpers. **This is the gate migration — highest scrutiny.** | `secret-fill.ts`, new contract test | **HIGH** (security gate) | **User-in-loop** (review the diff + the three contract assertions) |
| **C5** | **Taxonomy decision implementation** — per Decision 1. Either rewire `operation_start` as a shim (4A) or remove `operation_*` + picker lines + policies + audience (4B). Seed pre-bless into the surviving submit path. | `operations/tools.ts` or delete; `plugins.ts:181`, `tool-policies.apps.ts:49-53`, `tool-policies.globs.ts:14`, `audience-map.ts:88-92`, `agents/tools.ts:95`, `op-submit-async.ts:29` | **Med-high** (model-facing) | **User-in-loop** (it's their product call + system-prompt blast radius) |
| **C6** | **Decomposer decision** — per Decision 2. Port onto ops (5A) or delete (5B). | `decomposer.ts` (port or delete) + caller | **Med** | **User-in-loop** (their call) |
| **C7** | **Delete the dead fork.** Remove `src/operations/{conductor,executor,decomposer,tools,types,executor.test}.ts` once C2/C4/C5/C6 leave it with zero importers. Verify with a repo-wide import grep + full build. | delete `src/operations/` | **Low** (mechanical, last) | **Safe-autonomous** (after the above land) |

Notes:
- **C1 is shippable on its own, today**, independent of the whole merge — it's a standalone
  bugfix for a probably-broken security feature. Worth doing first regardless.
- C3 before C4 keeps the dangerous cutover to a single-data-source swap.
- C5/C6 are gated on the user's two decisions; until those land, C1–C4 + C7-minus-tools are all
  safely autonomous and already eliminate the *runtime* fork coupling.
- Each chunk should run `/canonical-check` (don't refork) and, for C4/C5 (shared anchors:
  the gate, the policy/audience/glob tables), `/blast-radius`.

---

## 7. Risk ledger

| Risk | Where | Severity | Mitigation / verification |
|---|---|---|---|
| **Gate widening — pre-bless outlives the op** | C3/C4: if the new query unions over all-ops-on-disk instead of live-ops-only, a completed op's pre-bless keeps auto-approving forever | **Critical** | New query filters to the in-memory running set (§2.2). Contract test asserts denial after op reaches terminal state (§2.5). |
| **Gate widening — "may read" treated as "pre-approved"** | C3: reusing `secrets.allowed` for pre-bless | **Critical** | Separate `secrets.preBlessed` field (§2.3). Test: name in `allowed` but not `preBlessed` does NOT bypass first-use. |
| **Origin binding bypass** | C4: a port reorders guardrails so pre-bless runs before origin check | **Critical** | Keep guardrail order byte-for-byte; only the data source changes. Test: pre-blessed secret on wrong origin still blocked. |
| **Pre-bless silently dead** (current state) | §1.4 / C1: reader/writer dir mismatch | **High** (already live) | C1 fixes the path; C4 makes it structural. Test: end-to-end pre-bless on the configured workspace, not `cwd`. |
| **Autopilot persistence breakage** | C2: moving the type changes a field autopilot writes | **Med** | Pure type move, same JSON shape, same dir. Run autopilot's tests + a round-trip read via `op-store.listOps()`. |
| **Broken delegation / model confusion** | C5: removing or rewiring `operation_start` desyncs the picker, system prompt, memory | **Med-high** | This is why C5 is user-in-loop. Update all picker strings + docs atomically. Eval the delegation picker (op-outcomes battery) before/after. |
| **Decomposer capability loss** | C6 (5B) | **Med** | User decision; if dropped, document the lost affordance. If ported (5A), unit-test the JSON carving + fallback path. |
| **Data loss — in-flight ops on upgrade** | C5 cutover | **Low** (already non-resumable) | Honest upgrade note (§3.3): old in-flight ops never resumed anyway; leave legacy dirs inert; prune later. No auto-migration that could corrupt. |
| **Orphan importer after delete** | C7 | **Low** | Repo-wide `grep -rE "operations/(conductor|executor|decomposer|tools|types)"` returns empty before deleting; full `npm run build`. |

---

## 8. Verification summary (per the "verify with build, not just tsc" rule)

- Every chunk: `npm run build` (hygiene + no-require gate), not just `tsc --noEmit`.
- C1, C4: the secret-fill cross-seam **contract test** (the load-bearing one) — the three
  assertions in §2.5 are the regression guard for the gate.
- C2: autopilot tests + `op-store.listOps()` round-trip.
- C5: delegation-picker eval (`eval/op-outcomes/`) before/after to catch mis-selection drift.
- C6 (if 5A): decomposer parse/fallback unit test (ported with the code).
- C7: import-grep clean + full build.

---

## 9. Answer to "is the merge advisable?"

**Yes, with scope discipline.** The fork is dormant and genuinely superseded by the canonical
engine on every axis except the two narrow couplings (privacy gate + autopilot type) and one
optional capability (the decomposer). The merge's real payoff is **deleting a parallel
delegation engine** (per the repo's standing "no forked systems" doctrine) **and fixing an
already-broken privacy feature** (the three-way `operations` directory split). The work is
cleanly chunkable; C1–C4 + C7 are mostly safe-autonomous and remove all runtime coupling, while
C5/C6 are deliberately parked on the user's two product decisions. The one place to move slowly
is C4 — the secret-fill gate cutover — where the contract test, not green unit tests, is what
proves the invariant held.
