# canonical-loop — module guide

The one state machine that runs every agent turn: op lifecycle, durable events,
per-turn checkpoints, control signals (pause / cancel / redirect / approvals),
leases and crash recovery. Chat, delegated agents, cron, self-edit and the
background verifiers are all "just an op" here. The locked v1 contract is
[docs/history/canonical-loop-prd.md](../../docs/history/canonical-loop-prd.md); the
issue-by-issue build log moved to
[docs/history/canonical-loop-v1-build.md](../../docs/history/canonical-loop-v1-build.md);
rollback is [docs/runbooks/canonical-loop-rollback.md](../../docs/runbooks/canonical-loop-rollback.md).

## The seal

Code outside this directory imports only `canonical-loop/index.js` or one
`canonical-loop/public/*.js` sub-barrel. `interface-seal.test.ts` scans every
`.ts` under `src/` and fails on any deeper specifier (static, dynamic or
type-only). `public/` exists because `index.js` sits inside a large import
cycle: modules that canonical-loop itself transitively imports
(`src/tool-execution/`, `src/chat-ws/`, registered tools, `src/ops/`) would mint
cycles if they pointed at `index.js`, so they read light pass-through barrels
such as `public/op-facts.ts` and `public/plan-ledger.ts` instead. Promote a
symbol there rather than deep-importing. `public/test-surface.ts` is test-only
(the same test enforces that).

## Entry points

| Caller | Entry | Where |
|---|---|---|
| Chat turn (`src/routes/chat/run-chat-turn/canonical-run.ts`) | `runChatViaCanonical()` — async generator of `ServerEvent`s | `chat-runner.ts` (+ `chat-runner/`) |
| Agents, cron, autopilot, self-edit, voice, background jobs | `runAgentViaCanonical()` — Promise of an `AgentTurn` | `agent-runner/run.ts` (re-exported by `agent-runner.ts`) |
| A single prepared op | `canonicalLoopEntry()` — seeds state, enqueues, pumps the scheduler | `index.ts` |

Both runners install the default middleware stack on first call
(`enableDefaultMiddlewareStack()` in `middlewares/host.ts`); until then the
loop runs zero middlewares.

## Core modules

| File | Role |
|---|---|
| `index.ts` | Front-door barrel plus `canonicalLoopEntry()`. |
| `types.ts` | State, lane, event (`CanonicalEventType`, `GuardOutcome`), turn-row and message-row shapes. |
| `schema.ts` | On-disk paths under `~/.lax/operations/<opId>/`: `canonical-events.jsonl`, `op-turns/<idx>.json`, `op-turns/<idx>.trace.json.gz`, `op-messages.jsonl`. |
| `store.ts` | Append-only event writer/reader (seq assigned under the cross-process op lock) and the turn/message readers. `turn-commit-store.ts` writes the turn row + messages atomically; `turn-trace-store.ts` writes the gzipped replay trace. |
| `bus.ts`, `event-emitter.ts` | `emit()` = append + publish on `op_events:{opId}`; `publishStreamChunk()` = bus-only `op_stream:{opId}`, never persisted. |
| `state-machine.ts` | Sole writer of `op.canonical.state`; validates transitions, emits `state_changed`. |
| `checkpoint.ts` | `commitTurn()` — idempotent per `(opId, turnIdx)`; writes the turn row, messages, `turn_committed` / `redirect_applied`, terminal transition. |
| `turn-loop.ts` | `driveTurn()` — the per-turn conductor (below). |
| `worker.ts` | `runWorker()` — leases an op, drives turns until terminal, releases. `worker-heartbeat.ts`, `worker-wall-clock.ts`, `worker-op-runtime.ts`, `worker-adapter-retry.ts` are its split-outs. |
| `scheduler.ts` | Single in-process queue, per-lane caps, dependency batches, backend selection. |
| `execution-backend.ts`, `execution-backend-registry.ts` | Placement boundary around the worker. Registered: `in-process-execution-backend.ts` (default; delegates once to `runWorker`), `process-execution-backend.ts` (forks `process-worker-entry.ts`; the one loop file allowed to import `child_process`, allow-listed by name in `test/canonical-loop-11-boundary-audit.test.ts`), `container-execution-backend.ts` (Docker, via `src/sandbox/docker-execution-runtime.ts`; `container-*.ts` are its projection, bootstrap and janitor). |
| `lease.ts` | `acquireLease` / `heartbeatLease` / `releaseLease`; sole writer of `leaseOwner` / `leaseExpiresAt`. |
| `recovery.ts`, `recovery-sweep.ts`, `recovery-janitor.ts` | `recoverStaleOp` takeover primitive; boot sweep; periodic `RecoveryJanitor`. |
| `control-api.ts` | `opEventsSince`, `subscribeOpEvents` / `subscribeOpStream`, `reconnectOp`, `opPause`, `opResume`, `opCancel`. |
| `control-api-redirect.ts`, `control-api-approvals.ts` | `opRedirect` / `opRedirectOnce`; `opResolveApproval` and the pending-approval record. |
| `signals.ts`, `cancel-handler.ts` | Bus fast-path for control signals; mid-stream cancel (`adapter.abort()` raced against 1s). Durable op columns stay the source of truth. |
| `tool-dispatch.ts`, `chat-tool-dispatcher.ts` | `ToolDispatcher` boundary — the loop never executes tools. Production wiring is `makeChatToolDispatcher()`, a per-op closure over `executeToolCalls` from `src/tool-execution/`. |
| `runtime.ts` | Per-op / per-lane adapter factories and tool-dispatcher registry. `provider-adapter-factory.ts` seals the delegated runtime descriptor. |
| `adapter-contract.ts`, `contract-types.ts` | The locked adapter interface (`Adapter`, `TurnInput`, `AdapterReport`, `TurnResult`) and `FORBIDDEN_ADAPTER_IMPORTS`. Type-only apart from that list. |

## Directories

| Dir | What lives there |
|---|---|
| `adapters/` | Provider adapters: `anthropic.ts`, `codex.ts`, `gemini-native.ts`, `openai-compat.ts` (+ `openai-compat/`), `app-build-adapter.ts`, `app-build-verify-adapter.ts`; their `*-transport.ts` files hold the subprocess / HTTP side; `tool-call-text-*.ts` is the one recognizer for tool calls written as text. |
| `chat-runner/` | Chat op creation, history seeding, adapter + runtime registration, the event pump that turns canonical events into `ServerEvent`s. |
| `agent-runner/` | The same for non-streaming callers: prompt, seed messages, result collection, runtime surface. |
| `middlewares/` | The safety stack (order below), `host.ts` phase runner, `registry.ts` declaration. |
| `turn-loop/` | Everything `driveTurn()` calls (below). |
| `public/` | Light sub-barrels for sealed consumers. |
| `instruction-ledger/` | Per-op ledger of the user's explicit run constraints (capability prohibitions, obligations) and enforced plan mode; filled on turn 0 by the `instruction-ledger` middleware. |
| `verification-*.ts` | After an op that ingested external content succeeds, a background op re-checks its deliverables: `verification-trigger.ts` (observer on the event seam), `-spend.ts` (bounds), `-brief.ts` (prompt), `-submit.ts` (op construction). |
| `publish-review-*.ts` | The awaited pre-publish reviewer that `src/tool-execution/publish-review-gate.ts` holds a push or deploy on: `-brief.ts`, `-submit.ts`, `-verdict.ts` (strict `VERDICT:` parser). |
| `process-relay-*.ts`, `*-worker-entry.ts`, `execution-worker-runtime.ts` | Out-of-process worker plumbing: relay contract, journal, reconcile, the forked / containerised entry points. |

## `turn-loop.ts` vs `turn-loop/`

`turn-loop.ts` (400 lines, at the ceiling) is the conductor: it exports
`driveTurn()` and owns only control flow — cancel checks, the three
middleware-phase short-circuits, the `commitTurn` call and
`bankEarnedFires` after it. Every helper it calls lives in `turn-loop/`
(~49 source files) and reaches it through the injectable seam
`turn-loop/turn-deps.ts`, so the conductor is testable without `vi.mock`:
`build-input.ts` (history + `compact-history.ts`, which delegates to
`src/context-manager/`), `inject-drain.ts`, `dispatch-tools.ts`,
`decide-outcome*.ts` + `continuation-guard.ts` + `terminal-epilogue.ts`
(terminal reason and the closing message), `nudges.ts` + `nudge-budget.ts`,
`guard-fire.ts`, `suspension.ts` + `adapter-throw-recovery.ts`,
`idle-watchdog.ts`, `record-outcome.ts`. Add behaviour in `turn-loop/`, never
in the conductor.

## Middleware order

`middlewares/registry.ts` declares the stack with explicit `order` keys and
`registry.test.ts` freezes the emitted sequence by name. `runMiddlewarePhase`
(`middlewares/host.ts`) walks it in that order and stops at the first
non-`continue` verdict. Per phase, the middlewares that implement the hook:

- **beforeTurn:** mid-turn-stale, instruction-ledger, loop-detection, open-steps, budget-ladder
- **afterModelCall:** office-theme-guard, loop-detection, repeat-output, premature-completion (worker ops only), verify-gate, open-steps, app-design-guard
- **afterToolExecution:** mid-turn-stale, loop-detection, repeat-output, verify-gate, post-edit-diagnostics, external-change-diff, app-design-guard, dead-end, repeat-failure, thrash-guard

Full registration order: mid-turn-stale, office-theme-guard, instruction-ledger,
loop-detection, repeat-output, premature-completion, verify-gate, open-steps,
budget-ladder, post-edit-diagnostics, external-change-diff, app-design-guard,
dead-end, repeat-failure, thrash-guard. `open-steps` is skipped when the op
forbids workspace writes (ledger or enforced plan mode).

## Lifecycle numbers

- **Lanes and caps** (`scheduler.ts`): `interactive` 10, `build` 2, `ide` 1, `background` 1, `agent` 5. Boot injects the live config reader, so `interactive` follows `maxInteractiveSessions`, `agent` follows `maxSubAgents`, and a global in-flight ceiling follows `maxConcurrentAgents` (fallback 12).
- **Lease** (`lease.ts`): 60s default; `LAX_LEASE_DURATION_MS` overrides within 30s–600s. **Heartbeat** every 10s (`worker-heartbeat.ts`); `claim_lost` is fatal at once; three consecutive transient failures are too.
- **Recovery:** `recoverStaleOp` evicts the dead worker, emits `lease_lost reason="expired"`, routes `running → queued` or `cancelling → cancelled`. It runs from the boot sweep (`src/server/canonical-loop-bootstrap.ts`) and then on a timer: `RecoveryJanitor` re-sweeps every lease duration for the life of the server. Policy backoff is intentionally not honored — requeue is immediate.
- **Wall clock** (`worker-wall-clock.ts`): armed on every lane from `contextPack.budget.maxWallTimeMs` and also read synchronously at the turn boundary. An `interactive` op ends `failed / deadline_exceeded`; every other lane ends `succeeded / iteration_checkpoint` with an `iteration_checkpoint { stopReason: "wall-clock" }` record. It never calls `opCancel`.
- **Control precedence:** cancel > pause > redirect. Cancel is mid-stream; pause and redirect apply at the next turn boundary.

## Boundaries

| Concern | Owner | Forbidden |
|---|---|---|
| Writing `canonical-events.jsonl` | `event-emitter.ts` via `store.ts` | Adapters, scheduler, backends. |
| Writing `op.canonical.state` | `state-machine.ts` | Everywhere else. |
| Writing turn rows / messages | `checkpoint.ts` via `turn-commit-store.ts` | Adapters, scheduler. |
| Provider I/O | `adapters/*` | The loop. No loop file imports `child_process` except `process-execution-backend.ts`. |
| Tool execution | `src/tool-execution/` behind the injected `ToolDispatcher` | Loop, adapter, worker direct execution. |
| Adapter imports | — | `FORBIDDEN_ADAPTER_IMPORTS` (`adapter-contract.ts`): `canonical-loop/store`, `ops/op-store`, `ops/event-log` (each with and without `.js`), `node:child_process`, `child_process`. `adapters/anthropic-transport.ts` is the single allow-listed transport file. The list is locked by the boundary audit. |

## Event vocabulary

`CanonicalEventType` (`types.ts`) is the union; two hand-kept lists must
match it: `EVENT_TYPES` in `store.ts` (a miss is SILENT — the reader truncates
the log at that row) and `CANONICAL_EVENT_TYPES` in
`process-relay-contract.ts` (a miss throws, out-of-process only).
`event-vocabulary.test.ts` fails the build when the union grows without them.
Add a new event to all three in one commit.

`middleware_fired { name, reason, outcome, turnIdx }` is minted only by
`turn-loop/guard-fire.ts` and counts a guard whose verdict TOOK EFFECT, never
an invocation. `outcome` (`GuardOutcome`, required on every `GuardFire`):

| `outcome` | Counted where |
|---|---|
| `nudge` | `turn-loop/nudges.ts` `appendNudgeAsUserMessage` — any synthetic user message that reached `op_messages`. |
| `abort` | `middlewareAbortResult` (beforeTurn) and `turn-loop/apply-directive.ts`; only when the error bubble is really emitted. |
| `suspend` | `turn-loop/suspension.ts` and `apply-directive.ts` (plus the idle watchdog). |
| `rewrite` | `middlewares/office-theme-guard.ts` — edits the tool call instead of speaking. |
| `honest-terminal` | A completion gate that lets the turn end but authors the closing words; banked after `commitTurn`. |
| `reopen` | A user follow-up that vetoed the terminal silently: `continuation-guard.ts` (inject already queued) or `decide-outcome-gates.ts` `late-inject` (landed during the verify gates). Sum both. |
| `repair` | `decide-outcome-gates.ts` framework-serve — fixed the environment (a dev server), not the conversation; only on `handled && ok`. |
| `gave-up` | `decide-outcome-verify-gates.ts` render-verify `capReached` — held an adverse verdict, no retries left. |

Fires whose effect is contingent on the commit ride `DecideOutcomeResult.earnedFires`
and are banked by `turn-loop.ts` after `commitTurn`; fires already spent are
minted at the branch. `appendHonestTerminal` (`turn-loop/empty-turn-termination.ts`)
has exactly two call sites — its own `empty-turn` terminal and the gate
terminal in `turn-loop/decide-outcome.ts` — and only the second is counted, so
`honest-terminal` is a census of gates, not of every harness-authored closing
message.

## Tests that enforce this file

`interface-seal.test.ts`, `event-vocabulary.test.ts`,
`middlewares/registry.test.ts`, `execution-backend-interface-seal.test.ts`
(backends never import the turn loop or a dispatcher),
`test/canonical-loop-11-boundary-audit.test.ts`.
