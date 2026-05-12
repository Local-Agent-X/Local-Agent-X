# Non-Chat `runAgent` Caller Inventory

**Audit ref:** AUDIT.md Critical #1 (three live agent-turn loops) + Critical #2 (canonical no-ops the legacy safety stack).
**Scope:** every `runAgent(` call site in `src/`. Pure inventory — feeds the P4.C3/C4/C5 migration chunks.
**Date:** 2026-05-12 (P4.C1).

`runAgent` is defined at [src/agent.ts:42](../src/agent.ts#L42). Unless `LAX_UNIFIED_LOOP=1` (off by default), it dispatches to one of three legacy per-provider loops:

- [src/providers/run-anthropic.ts:20](../src/providers/run-anthropic.ts#L20) — `runAnthropicAgent`
- [src/agent-codex/run-http.ts:31](../src/agent-codex/run-http.ts#L31) — `runCodexAgent`
- [src/providers/run-standard.ts:20](../src/providers/run-standard.ts#L20) — `runStandardAgent` (openai / xai / gemini / local / custom)

Every caller below inherits whichever of those three loops their `options.provider` selects.

## Legacy-loop middleware coverage (the gap canonical-loop has)

Inlined in **all three** legacy loops (universal coverage every caller relies on):

| Middleware (AUDIT Crit #2) | Anthropic loop | Standard loop | Codex loop |
|---|---|---|---|
| loop-detection (`checkToolLoops`) | [run-anthropic.ts:311](../src/providers/run-anthropic.ts#L311) | [run-standard.ts:334](../src/providers/run-standard.ts#L334) | [run-http.ts:407](../src/agent-codex/run-http.ts#L407) |
| dead-end nudge (`checkDeadEnd`) | [run-anthropic.ts:346](../src/providers/run-anthropic.ts#L346) | [run-standard.ts:369](../src/providers/run-standard.ts#L369) | [run-http.ts:460](../src/agent-codex/run-http.ts#L460) |
| post-commit nudge (`checkPostCommit`) | [run-anthropic.ts:361](../src/providers/run-anthropic.ts#L361) | [run-standard.ts:385](../src/providers/run-standard.ts#L385) | [run-http.ts:475](../src/agent-codex/run-http.ts#L475) |
| hallucination check (approval+creation) | [run-anthropic.ts:281-291](../src/providers/run-anthropic.ts#L281) | [run-standard.ts:285-296](../src/providers/run-standard.ts#L285) | [run-http-helpers.ts:371-382](../src/agent-codex/run-http-helpers.ts#L371) |
| action-claim check (`checkUnmatchedActionClaim`) | [run-anthropic.ts:261](../src/providers/run-anthropic.ts#L261) | [run-standard.ts:301](../src/providers/run-standard.ts#L301) | [run-http-helpers.ts:387](../src/agent-codex/run-http-helpers.ts#L387) |
| self-check (`detectUnresolvedErrors`) | [run-anthropic.ts:296](../src/providers/run-anthropic.ts#L296) | [run-standard.ts:313](../src/providers/run-standard.ts#L313) | [run-http-helpers.ts:413](../src/agent-codex/run-http-helpers.ts#L413) |
| mid-turn-evidence-stale | [run-anthropic-helpers.ts:110](../src/providers/run-anthropic-helpers.ts#L110) | [run-standard-helpers.ts:105](../src/providers/run-standard-helpers.ts#L105) | [run-http-helpers.ts:210](../src/agent-codex/run-http-helpers.ts#L210) |
| post-turn-detector | [run-anthropic.ts:254](../src/providers/run-anthropic.ts#L254) | [run-standard.ts:277](../src/providers/run-standard.ts#L277) | [run-http.ts:374](../src/agent-codex/run-http.ts#L374) |

Provider-specific (NOT universal):

| Middleware | Where | Affects |
|---|---|---|
| force-tool-use (initial iteration) | [run-http.ts:79](../src/agent-codex/run-http.ts#L79) | Codex callers only |
| auto-route-build-app | [run-anthropic.ts:216](../src/providers/run-anthropic.ts#L216) | Anthropic callers only |

Also inline in all three legacy loops (not in AUDIT Crit #2 list but relevant): context-overflow `forceCompact` retry.

**Effective rule for the cross-ref column below:** any caller running >1 iteration on any provider gets the eight "universal" middlewares; Codex-only callers also get force-tool-use; Anthropic-only callers also get auto-route-build-app. Callers pinned to `maxIterations: 1` short-circuit before the iteration-loop middlewares fire (loop/dead-end/post-commit/mid-turn-stale/post-turn-detector) — they still get hallucination check + action-claim check + self-check, which run inside the single iteration.

## Caller inventory

| # | Bucket | File:Line | Trigger | Provider(s) | maxIter | Middleware coverage relied on | Replay/reconnect? |
|---|---|---|---|---|---|---|---|
| 1 | chat (legacy fallback) | [routes/chat.ts:433](../src/routes/chat.ts#L433) | `POST /api/chat` SSE when `canonicalChatEligible === false` (feature flag off OR provider not in `CANONICAL_CHAT_PROVIDERS` set, currently empty in practice — see note A) | any of {anthropic, codex, local, ollama-cloud, xai, openai, gemini, custom} | `prepared.maxIterations` (config) | All eight universal middlewares + provider-specific extras | No |
| 2 | chat (legacy fallback rescue) | [routes/chat.ts:555](../src/routes/chat.ts#L555) | Inside #1's empty/transient-error rescue chain (`fallbackOrder: codex → anthropic → xai`) | sequential: codex, anthropic, xai | `prepared.maxIterations` | Same as #1 | No |
| 3 | delegation-handoff | [routes/chat/delegation-handoff.ts:98](../src/routes/chat/delegation-handoff.ts#L98) | `routeMessage` returns `delegate` inside `/api/chat`: tiny ack turn after worker takes the real work | per-request (any) | **1** | hallucination + action-claim + self-check only (single-iteration; loop/dead-end/post-commit short-circuit; `tools: []` so most can't fire anyway) | No |
| 4 | cron | [server/background-jobs.ts:118](../src/server/background-jobs.ts#L118) | `cronService.onExecute` — every scheduled mission tick | per-request (any); Anthropic forced to `claude-sonnet-4-6` at :93 | `config.maxIterations` | All eight universal middlewares + provider-specific extras. **Hard 10-min `MISSION_HARD_TIMEOUT_MS` abort** at :111 (cron only — replaces wall-clock-ceiling for this caller) | No |
| 5 | worker-pool (app-builder) | [server/background-jobs.ts:233](../src/server/background-jobs.ts#L233) | `worker-session.registerWorkerRunner` callback — UI/agent invoking the app-builder worker | `resolveProvider(...)` (any) | **15** | All eight universal middlewares + provider-specific extras | No |
| 6 | cron (memory-dream, no-batch) | [server/background-jobs.ts:349](../src/server/background-jobs.ts#L349) | 2h `runDreamCheck` scheduler when no transcript batches | `resolveProvider(...)`; Anthropic forced to `claude-haiku-4-5` at :340 | **10** | All eight universal middlewares + provider-specific extras | No |
| 7 | cron (memory-dream, per-batch) | [server/background-jobs.ts:358](../src/server/background-jobs.ts#L358) | Same scheduler, per transcript batch (loop at :356) | same as #6 | **15** | Same as #6 | No |
| 8 | sub-agent | [server/handler-events.ts:126](../src/server/handler-events.ts#L126) | `handler:agent-spawn` event from tool calls `agent_spawn` / `delegate` (via `Handler.spawnAgent`) | per-agent (any, derived from `AgentDefinition`) | `config.maxIterations` | All eight universal middlewares + provider-specific extras. **Hard `config.agentTimeoutMs` abort** at :125 | No |
| 9 | voice | [server/lifecycle.ts:205](../src/server/lifecycle.ts#L205) | `voiceTurnRunner` invoked by `/ws/voice` STT final transcript | per-request (any) | **1** (or **2** if `voice_visuals_enabled`) | hallucination + action-claim + self-check; iteration-loop middlewares short-circuit. `tools: []` or `[voice_visual]` only | No |
| 10 | autopilot | [autopilot/round-agent.ts:94](../src/autopilot/round-agent.ts#L94) | Every round of `runAutopilotLoop` (started via `POST /api/autopilot/start`) | `deps.provider` (any) | `deps.config.maxIterations` | All eight universal middlewares + provider-specific extras. Round agent runs minus `mission_schedule_*` tools | No |
| 11 | worker-pool (op subprocess) | [workers/worker-entry.ts:220](../src/workers/worker-entry.ts#L220) | Parent pool sends `assign-op` over stdin → subprocess handler; covers `delegateMessageToWorker` route, autopilot worker dispatches, and any other context-pack op | `resolveProvider(..., providerOverride)` (any) | `op.contextPack.budget.maxIterations` | All eight universal middlewares + provider-specific extras | No (parent emits checkpoint events but caller has no in-process replay) |

**Note A — chat fallback callers (#1, #2):** the `CANONICAL_CHAT_PROVIDERS` set at [routes/chat.ts:274](../src/routes/chat.ts#L274) contains every provider type `AgentOptions.provider` accepts. With `isCanonicalChatEnabled()` true (default), the canonical branch always wins and returns at :413/:429 before reaching :433. #1 and #2 are reachable only when the canonical feature flag is explicitly disabled. They remain code-live and ship in the bundle, so they're listed here for completeness — but they're the lowest-priority migration target.

## Bucket totals

| Bucket | Count | Callers |
|---|---|---|
| cron | 3 | #4, #6, #7 |
| autopilot | 1 | #10 |
| sub-agent | 1 | #8 |
| worker-pool | 2 | #5 (app-builder runner), #11 (op subprocess) |
| voice | 1 | #9 |
| delegation-handoff | 1 | #3 |
| other (chat legacy fallback) | 2 | #1, #2 |

**Total:** 11 call sites across 7 files. Matches the `\brunAgent\(` grep below.

## Smoke

```
$ git grep -nE "\brunAgent\(" src/
src/agent.ts:42                                     # the export itself, not a caller
src/autopilot/round-agent.ts:4                      # docstring reference, not a call
src/autopilot/round-agent.ts:94                     # #10
src/routes/chat.ts:433                              # #1
src/routes/chat.ts:555                              # #2
src/routes/chat/delegation-handoff.ts:98            # #3
src/server/background-jobs.ts:118                   # #4
src/server/background-jobs.ts:233                   # #5
src/server/background-jobs.ts:349                   # #6
src/server/background-jobs.ts:358                   # #7
src/server/handler-events.ts:126                    # #8
src/server/lifecycle.ts:205                         # #9
src/whatsapp-bridge.ts:7                            # docstring reference, not a call
src/workers/worker-entry.ts:220                     # #11
```

14 grep hits → 11 real call sites + 1 export (`agent.ts:42`) + 2 docstring references (`round-agent.ts:4`, `whatsapp-bridge.ts:7`). The WhatsApp bridge docstring is stale — the actual WhatsApp inbound path goes canonical via `bridgeMessageHandler → runChatViaCanonical` (AUDIT §1.2.1), it does not call `runAgent` directly.

## Migration scope (handoff to P4.C3/C4/C5)

Every caller in this table is a target. Out of the 11:

- **9 production-load callers** (#3–#11) — must keep functioning through the migration.
- **2 dead-under-default callers** (#1, #2) — can be removed outright if the canonical feature flag becomes mandatory in the same pass.

None of the 11 has replay/reconnect; that's a uniform gap canonical-loop closes via `op_messages.jsonl` + `reconnectOp`. Three callers have caller-side hard abort timers that today substitute for canonical's wall-clock-ceiling middleware: #4 (10 min mission), #8 (`config.agentTimeoutMs` per sub-agent). The migration must preserve those budgets (likely by passing them through canonical's per-op `walletClockMs` field rather than continuing to mint `AbortController`s outside the loop).
