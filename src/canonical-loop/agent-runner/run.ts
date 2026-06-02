/**
 * Non-chat canonical-loop runner.
 *
 * Promise-based equivalent of `runChatViaCanonical` for callers that do not
 * stream events to a UI: cron missions, autopilot rounds, memory-dream
 * consolidation. Takes a runAgent-style signature (userMessage, history,
 * options) and returns an `AgentTurn`-shaped Promise so existing callers
 * swap with minimal diff.
 *
 * Wall-clock-ceiling: `options.wallClockMs` is stamped onto the op's
 * `budget.maxWallTimeMs`. The worker enforces it — the single place every
 * entry path shares — so cron/autopilot/sub-agent runs and chat turns all
 * get the same ceiling from one source instead of each runner arming its
 * own timer. No outside-the-loop AbortController.
 *
 * External cancel: `options.signal` is wired to also call `opCancel`, so
 * callers that need an external cancel hook (e.g. cron's `registerRunAbort`
 * for "stop this running mission" API endpoints) keep their existing
 * AbortController interface — the signal now routes through canonical.
 *
 * Middleware stack: installs the default canonical safety stack on first
 * call (same opt-in mechanism `chat-runner` uses, sharing the same
 * `activeStack` module-level state).
 */
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { newOpId, writeOp } from "../../ops/op-store.js";
import { buildContextPack } from "../../ops/context-pack-builder.js";
import { getRetryPolicy } from "../../ops/heartbeat.js";
import { trackOpForSession } from "../../ops/session-bridge.js";
import type { Op, OpLane, OpVisibility } from "../../ops/types.js";
import type { AgentTurn } from "../../types.js";

import { canonicalLoopEntry } from "../index.js";
import {
  registerToolDispatcherForOp,
  unregisterToolDispatcherForOp,
  registerToolsForOp,
  unregisterToolsForOp,
} from "../runtime.js";
import { enableDefaultMiddlewareStack, getActiveMiddlewareStack } from "../middlewares/host.js";
import { opCancel, subscribeOpEvents, subscribeOpStream } from "../control-api.js";
import { readOpTurns } from "../store.js";
import { isCommittingTool } from "../../committing-tool-check.js";
import { makeChatToolDispatcher } from "../chat-tool-dispatcher.js";
import type { CanonicalEvent, StateChangedBody } from "../types.js";
import { isTerminalState, type TerminalState } from "../terminal-states.js";
import { createLogger } from "../../logger.js";

import { type CanonicalAgentOptions, DEFAULT_WALL_CLOCK_MS } from "./types.js";
import { registerProviderAdapter } from "./register-adapter.js";
import { seedOpMessages } from "./seed-messages.js";
import { collectMessages, mapStopReason } from "./collect-result.js";

const logger = createLogger("canonical-loop.agent-runner");

export async function runAgentViaCanonical(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: CanonicalAgentOptions,
): Promise<AgentTurn> {
  if (getActiveMiddlewareStack().length === 0) {
    enableDefaultMiddlewareStack();
  }

  const opType = options.opType ?? "agent_turn";
  const lane: OpLane = options.lane ?? "background";
  const wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const sessionId = options.sessionId ?? `agent-${randomUUID().slice(0, 8)}`;

  const contextPack = await buildContextPack({
    description: userMessage,
    successCriteria: [],
    constraints: [],
    lane,
    preferredProvider: options.provider,
    budget: {
      maxIterations: options.maxIterations || 30,
      maxWallTimeMs: wallClockMs,
    },
  });

  const op: Op = {
    id: newOpId(`op_${opType}`),
    type: opType,
    task: userMessage,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  trackOpForSession(op.id, sessionId, userMessage);
  writeOp(op);

  seedOpMessages(op.id, history, userMessage, options.images);
  await registerProviderAdapter(op.id, options, sessionId);

  // Bridge canonical opCancel → tool-execution AbortSignal so subprocesses
  // (self_edit's claude -p, build_app's codex --full-auto) actually die on
  // Stop instead of running to natural completion while the op hangs in
  // `cancelling`. Composes with the caller's optional external signal.
  const { bridgeOpCancelToToolSignal } = await import("../cancel-handler.js");
  const cancelBridge = bridgeOpCancelToToolSignal(op.id, options.signal);

  registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
    tools: options.tools,
    security: options.security,
    toolPolicy: options.toolPolicy,
    threatEngine: options.threatEngine,
    rbac: options.rbac,
    callerRole: options.callerRole,
    sessionId,
    opId: op.id,
    runId: options.runId,
    onEvent: options.onEvent,
    signal: cancelBridge.signal,
  }));

  registerToolsForOp(op.id, options.tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  })));

  let terminal: TerminalState | null = null;
  let errorMessage: string | undefined;
  let errorCode: string | undefined;
  let waiter: (() => void) | null = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  const offEvents = subscribeOpEvents(op.id, (event: CanonicalEvent) => {
    if (event.type === "state_changed") {
      const body = event.body as StateChangedBody | undefined;
      const to = body?.to;
      if (isTerminalState(to)) {
        terminal = to;
        wake();
      }
      return;
    }
    if (event.type === "error" && !errorMessage) {
      const b = (event.body ?? {}) as Record<string, unknown>;
      errorCode = (b.code as string | undefined) ?? "error";
      const message = (b.message as string | undefined) ?? "(no message)";
      errorMessage = `${errorCode}: ${message}`;
    }
  });

  // Adapter-emitted text deltas live on a separate bus channel (chat-runner
  // drains them with subscribeOpStream and yields `{ type: "stream", delta }`
  // SSE events). Tool start/end/progress events already reach options.onEvent
  // through the chat-tool-dispatcher → executeToolCalls bridge, but stream
  // chunks have no equivalent path on this runner. Without this bridge the
  // sub-agent's live text doesn't reach handler:agent-output and the AGENTS
  // sidebar sits silent during a spawned agent's reply (P4.C4 finding).
  const offStream = options.onEvent
    ? subscribeOpStream(op.id, (chunk) => {
        const c = chunk as { delta?: string; replace?: boolean; text?: string } | null;
        if (c?.replace === true) {
          options.onEvent!({ type: "stream", replace: true, text: c.text ?? "" });
          return;
        }
        const delta = c?.delta;
        if (typeof delta !== "string" || delta.length === 0) return;
        options.onEvent!({ type: "stream", delta });
      })
    : () => {};

  // External signal → opCancel. Preserves the cron service's existing
  // registerRunAbort interface for cancel-from-API while routing the
  // actual abort through canonical instead of the AbortController bypass.
  const onSignalAbort = () => {
    logger.info(`[agent-runner] op ${op.id} received external abort signal — issuing opCancel`);
    opCancel(op.id, "external-signal");
  };
  if (options.signal) {
    if (options.signal.aborted) onSignalAbort();
    else options.signal.addEventListener("abort", onSignalAbort);
  }

  try {
    canonicalLoopEntry(op, { sessionId });
    logger.info(`[agent-runner] submitted op ${op.id} type=${opType} lane=${lane} model=${options.model} wallClock=${wallClockMs}ms tools=${options.tools.length}`);

    while (terminal === null) {
      await new Promise<void>(r => { waiter = r; });
    }

    const messages = collectMessages(op.id, history, userMessage, options.systemPrompt);
    const stopReason = mapStopReason(terminal, errorCode);
    // Authoritative committing-work signal from the host.ts ledger: a turn's
    // toolCallSummary only proves work when resultStatus === "ok". This status
    // is stripped from AgentTurn.messages, so it must be computed here where
    // op.id is in scope and the result-guard downstream can trust it.
    let committedWork = false;
    for (const turn of readOpTurns(op.id)) {
      for (const s of turn.toolCallSummary ?? []) {
        if (s.resultStatus !== "ok") continue;
        if (isCommittingTool(s.tool)) { committedWork = true; break; }
      }
      if (committedWork) break;
    }
    const result: AgentTurn = {
      messages,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason,
      committedWork,
    };
    if (errorMessage && stopReason === "error") result.errorMessage = errorMessage;
    return result;
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onSignalAbort);
    offEvents();
    offStream();
    cancelBridge.dispose();
    unregisterToolDispatcherForOp(op.id);
    unregisterToolsForOp(op.id);
  }
}
