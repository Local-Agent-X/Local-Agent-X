# canonical-loop — module map

Source of truth: [docs/canonical-loop-prd.md](../../docs/canonical-loop-prd.md).

This directory is the canonical-loop runtime — one state machine that owns
op lifecycle, events, checkpoints, signals, and crash recovery (PRD §6
Decision #1). Adapters live alongside (e.g., `anthropic-adapter`,
`codex-adapter`); this dir is provider-neutral.

## Files

| File | Role | LOC limit |
|---|---|---|
| `index.ts` | Public entry — exports + `canonicalLoopEntry()` (the seam `op_submit_async` calls when the canonical flag is ON for the lane). | ≤ 400 |
| `types.ts` | Canonical-state, lane, event, op-fields, turn-row, message-row, provider-state-envelope shapes (PRD §5 / §9). | ≤ 400 |
| `schema.ts` | On-disk paths under `~/.lax/operations/<opId>/` — canonical-events.jsonl, op-turns/, op-messages.jsonl. | ≤ 400 |
| `store.ts` | Append-only writers/readers for `op_events`, `op_turns`, `op_messages`. Sole disk gateway. | ≤ 400 |
| `feature-flag.ts` | Env-driven per-lane flag reader (`lax.canonical_loop.{lane}`, PRD §17). | ≤ 400 |
| `router.ts` | Pure submit-time routing decision (legacy vs canonical). | ≤ 400 |
| `bus.ts` | In-process pub/sub bus. Channels: `op_events:{opId}` (durable mirror) + `op_stream:{opId}` (ephemeral). | ≤ 400 |
| `event-emitter.ts` | `emit()` = append to `op_events` + publish to bus. `publishStreamChunk()` = bus only. | ≤ 400 |
| `state-machine.ts` | Sole writer of `op.canonical.state`. Validates transitions, emits `state_changed`. | ≤ 400 |
| `tool-dispatch.ts` | `ToolDispatcher` boundary — loop never executes tools itself. Default = no-op; production wiring delegates to `tool-executor.ts`. | ≤ 400 |
| `runtime.ts` | Adapter-factory and tool-dispatcher registry singletons. | ≤ 400 |
| `checkpoint.ts` | `commitTurn()` — atomic post-turn write (op_messages + op_turns + canonical events + terminal-state transition). | ≤ 400 |
| `turn-loop.ts` | `driveTurn()` — inner per-turn driver. Calls adapter, fans tool calls, commits. | ≤ 400 |
| `worker.ts` | `runWorker()` — leases an op, drives the turn_loop until terminal, releases. | ≤ 400 |
| `scheduler.ts` | Single in-process queue + per-lane caps. `enqueueOp` / `pumpScheduler` / `awaitIdle`. | ≤ 400 |
| `adapter-contract.ts` | Locked PRD §15 adapter interface (`Adapter`, `TurnInput`, `AdapterReport`, `TurnResult`) + sandbox import deny-list. Type-only. | ≤ 400 |
| `contract-types.ts` | Value-shape types referenced by the adapter contract (`CanonicalMessage`, `ToolCall`, `ToolDescriptor`). Type-only. | ≤ 400 |

## Boundaries

| Concern | Owner | Forbidden |
|---|---|---|
| Writing `op_events` | `event-emitter.ts` (via `store.ts`). | Adapters, scheduler, worker outside `state-machine.ts`/`turn-loop.ts`/`checkpoint.ts`. |
| Writing `op.canonical.state` | `state-machine.ts`. | Everywhere else. |
| Writing `op_turns` / `op_messages` | `checkpoint.ts` (via `store.ts`). | Adapters, scheduler. |
| Provider I/O | per-provider adapters (NOT in this dir). | Loop itself; `child_process` is forbidden in canonical-loop modules. |
| Tool execution | `tool-executor.ts` via injected `ToolDispatcher`. | Loop / adapter / worker direct execution. |
| Public-control signals | `op_*` public APIs (Issue 05+). | Loop never writes signal columns. |

## Issue 03 happy-path event sequence (single text-only turn)

```
seq=0  state_changed   { from: null, to: "queued",   reason: "submitted" }
seq=1  lease_acquired  { workerId }
seq=2  state_changed   { from: "queued",  to: "running", reason: "leased" }
seq=3  turn_started    { turnIdx: 0 }
seq=4  message_appended{ turnIdx: 0, role: "assistant", messageId }
seq=5  turn_committed  { turnIdx: 0, messageCount, toolCount }
seq=6  state_changed   { from: "running", to: "succeeded", reason: "turn_done" }
seq=7  lease_lost      { workerId, reason: "released" }
```

Stream chunks are NOT in this list — they ride `op_stream:{opId}` only and
are never persisted to `op_events` (PRD §12).
