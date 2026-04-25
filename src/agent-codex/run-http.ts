import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../types.js";
import { streamCodexResponse, type ReasoningItem } from "../codex-client.js";
import { executeToolCalls, checkAndCompact } from "../tool-executor.js";
import { stripEphemeralMessages } from "../agent-providers.js";
import { checkToolLoops, createLoopState, checkDeadEnd, createDeadEndState } from "../agent-guards.js";
import { stripSystemInjectionTags } from "../sanitize.js";
import type { AgentOptions } from "./shared.js";
import {
  buildUserContent,
  checkTokenCeiling,
  checkWallClockCeiling,
  checkMidTurnStale,
  drainSubagentCompletions,
  handleEmptyResponse,
  handleNoToolCallBranch,
} from "./run-http-helpers.js";

// ── HTTP path (canonical) ──

export async function runCodexAgentHttp(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const { apiKey, model, systemPrompt, tools, security, maxIterations = 160, onEvent, signal } = options;
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const userContent = await buildUserContent(userMessage, options.images);

  let messages: ChatCompletionMessageParam[] = [...history, { role: "user", content: userContent } as ChatCompletionMessageParam];
  let totalInput = 0, totalOutput = 0;
  let previousResponseId: string | undefined;
  // Track how many messages existed before each turn so we can compute
  // incremental input (tool results only) for the next request.
  let lastContextLength = 0;
  const codexTools = tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters }));
  const loopState = createLoopState();
  const deadEndState = createDeadEndState();
  let selfCheckFired = false;
  let contentFilterEmpties = 0;
  // Names of every tool called in this turn (across all iterations). Used by
  // checkUnmatchedActionClaim to detect hallucinated action claims — if the
  // agent says "Removed X" but never called sidebar_unpin/delete/etc., nudge.
  const toolsCalledThisTurn = new Set<string>();
  let unmatchedClaimNudged = false;
  // Post-turn validation state: retry counters, layered prompt instructions,
  // and evidence history for staleness detection.
  const { createRetryCounters, runPostTurnDetectors, computeEvidenceCount } =
    await import("../agent-loop-detectors.js");
  const { createPromptLayers, composeSystemPrompt, isAckMessage, ACK_FAST_PATH_INSTRUCTION } =
    await import("../agent-loop-prompt-layers.js");
  const retryCounters = createRetryCounters();
  const promptLayers = createPromptLayers();
  const evidenceHistory: number[] = [];
  // One-shot ack fast-path when the user's latest message was a short approval
  if (isAckMessage(userMessage)) {
    promptLayers.ackFastPath = ACK_FAST_PATH_INSTRUCTION;
  }

  // Detect build/action intent — force tool use on iteration 0 to prevent
  // the model from responding with text instead of calling a tool.
  const BUILD_INTENT_RE = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
  const ACTION_INTENT_RE = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;
  const shouldForceTools = BUILD_INTENT_RE.test(userMessage) || ACTION_INTENT_RE.test(userMessage);

  // Per-turn safety ceilings:
  //  - Token ceiling (expensive-runaway protection)
  //  - Wall-clock ceiling (time-runaway protection for long stuck turns)
  //  - Mid-turn staleness (fire the evidence-stale detector DURING the turn,
  //    not only at exit, so a 330-second bash loop with no commit can't
  //    silently burn forever)
  const turnStartMs = Date.now();
  const committingToolsThisTurn = new Set<string>();
  // Heartbeat ticker so the UI sees live progress instead of "Still waiting..."
  // Auto-stops when the turn-lock releases (tied to the chat route's finally).
  const { startHeartbeat } = await import("../session-heartbeat.js");
  const heartbeat = startHeartbeat({ sessionId: options.sessionId, onEvent, turnStartMs });
  const { onTurnRelease } = await import("../session-turn-lock.js");
  onTurnRelease(options.sessionId, () => heartbeat.stop());

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };

    const ceilingState = { totalInput, totalOutput, systemPrompt, messages, sessionId: options.sessionId, model };
    const tokenAbort = checkTokenCeiling(ceilingState);
    if (tokenAbort) return tokenAbort;

    // Wall-clock ceiling — safety net for turns that don't burn tokens fast
    // but grind on tool calls without ever committing. Only fires when no
    // committing tool has been called this turn.
    const wallClockAbort = checkWallClockCeiling(ceilingState, turnStartMs, iteration, committingToolsThisTurn, toolsCalledThisTurn);
    if (wallClockAbort) return wallClockAbort;

    // Mid-turn evidence-staleness: after MID_TURN_MIN_ITERATION, check the
    // last MID_TURN_EVIDENCE_STALE_WINDOW evidence counts. If flat and no
    // committing tool has been called, abort — the agent is spinning without
    // progress. Differs from the post-turn staleness check which only runs
    // at exit; this one catches stuck-in-middle cases too.
    const staleAbort = checkMidTurnStale(ceilingState, iteration, evidenceHistory, committingToolsThisTurn);
    if (staleAbort) return staleAbort;

    if (iteration > 0) messages = stripEphemeralMessages(messages);
    messages = checkAndCompact(messages, model, onEvent);

    // Drain subagent completion queue — push-based signaling so the parent
    // doesn't burn iterations polling agent_status.
    const drained = await drainSubagentCompletions(messages, options.sessionId);
    if (drained) {
      // Invalidate previousResponseId so Codex sees the newly-pushed message
      previousResponseId = undefined;
      lastContextLength = 0;
    }

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let turnReasoning: ReasoningItem[] = [];

    // Incremental mode: when we have a previousResponseId AND the only new
    // messages since our last turn are tool results, send just those results
    // instead of the full conversation. This saves input tokens and avoids
    // re-sending the entire history on every tool-call loop.
    let streamMessages: ChatCompletionMessageParam[];
    let turnPreviousResponseId: string | undefined;
    if (previousResponseId && lastContextLength > 0) {
      const newMessages = messages.slice(lastContextLength);
      const allToolResults = newMessages.length > 0 && newMessages.every(
        (m) => m.role === "tool" || (m.role === "assistant" && (m as unknown as Record<string, unknown>).tool_calls)
      );
      if (allToolResults) {
        // Incremental: only send the new tool result messages
        streamMessages = newMessages;
        turnPreviousResponseId = previousResponseId;
      } else {
        // Full context restart — something other than tool results was added
        streamMessages = messages;
        turnPreviousResponseId = undefined;
      }
    } else {
      streamMessages = messages;
    }

    lastContextLength = messages.length;

    // Note: Codex subscription endpoint (chatgpt.com/backend-api) returns empty
    // responses when tool_choice:"required" is sent. Keep as "auto" for Codex.
    // Build intent is enforced via the system prompt instead.
    const toolChoice = "auto" as const;

    const layeredSystemPrompt = composeSystemPrompt(systemPrompt, promptLayers);

    try {
      const stream = streamCodexResponse({
        token: apiKey,
        model,
        messages: streamMessages,
        systemPrompt: layeredSystemPrompt,
        tools: codexTools,
        previousResponseId: turnPreviousResponseId,
        sessionId: options.sessionId,
        toolChoice,
      });

      for await (const event of stream) {
        if (event.type === "text") { assistantContent += event.delta; onEvent?.({ type: "stream", delta: event.delta }); }
        else if (event.type === "tool_call") { toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments }); }
        else if (event.type === "reasoning") { turnReasoning.push(event.item); }
        else if (event.type === "done") {
          totalInput += event.usage.inputTokens;
          totalOutput += event.usage.outputTokens;
          if (event.responseId) previousResponseId = event.responseId;
          // Merge any reasoning from the done event that wasn't streamed
          if (event.reasoning.length > 0 && turnReasoning.length === 0) {
            turnReasoning = event.reasoning;
          }
        }
      }
    } catch (e) {
      const errMsg = (e as Error).message || "Stream error";
      const { isContextOverflowError, forceCompact } = await import("../context-manager.js");
      if (isContextOverflowError(e) && iteration < maxIterations - 1) {
        const before = messages.length;
        messages = forceCompact(messages, 2);
        previousResponseId = undefined; // Force full-context restart next turn
        lastContextLength = 0;
        console.warn(`[agent] Codex context overflow — force-compacted ${before} → ${messages.length} msgs and retrying`);
        try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "context-overflow", sessionId: options.sessionId, detail: { provider: "codex", model, before, after: messages.length } })).catch(() => {}); } catch {}
        onEvent?.({ type: "context_status", percentage: 100, level: "emergency", usedTokens: 0, maxTokens: 0, compacted: true });
        continue;
      }
      // Recovery for the 400 "No tool output found" error. This fires when
      // our incremental-response path (previousResponseId + send-only-new-
      // tool-results) drops or misorders a tool result, so the next request
      // references a tool_call_id whose output isn't in the context Codex
      // has. Fix: drop the response-id continuity, force a full-context
      // resubmission on the next iteration. Costs the input tokens of one
      // extra turn but recovers cleanly instead of failing the session.
      if (/No tool output found for function call/i.test(errMsg) && iteration < maxIterations - 1) {
        console.warn(`[agent] Codex 400 "No tool output found" — invalidating previousResponseId and resending full context`);
        try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "codex", model, detail: { reason: "no-tool-output-recovery", iteration } })).catch(() => {}); } catch {}
        previousResponseId = undefined;
        lastContextLength = 0;
        continue;
      }
      console.error("[agent] Codex HTTP stream error:", errMsg);
      onEvent?.({ type: "error", message: errMsg });
      // On error, invalidate previousResponseId so the next attempt
      // sends the full context instead of trying incremental mode
      previousResponseId = undefined;
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
        errorMessage: errMsg,
      };
    }

    // Empty response — retry once silently. Codex sometimes returns empty on
    // the first attempt but succeeds on immediate retry.
    if (toolCalls.length === 0 && !assistantContent.trim()) {
      const empty = await handleEmptyResponse({
        apiKey,
        model,
        systemPrompt,
        messages,
        codexTools,
        toolCalls,
        assistantContent,
        turnReasoning,
        totalInput,
        totalOutput,
        iteration,
        contentFilterEmpties,
        onEvent,
      });
      assistantContent = empty.assistantContent;
      turnReasoning = empty.turnReasoning;
      totalInput = empty.totalInput;
      totalOutput = empty.totalOutput;
      contentFilterEmpties = empty.contentFilterEmpties;
      previousResponseId = empty.previousResponseId;
      if (empty.abortTurn) return empty.abortTurn;
      if (empty.injectedNudge) {
        lastContextLength = 0;
        continue;
      }
    }

    // Build the assistant message, attaching reasoning items as _reasoning
    // metadata so they can be replayed in convertMessagesToInput() on the
    // next turn. The Responses API requires reasoning to be present.
    const assistantMsg: ChatCompletionMessageParam = { role: "assistant", content: assistantContent || null };
    const assistantRecord = assistantMsg as unknown as Record<string, unknown>;
    if (toolCalls.length > 0) {
      assistantRecord.tool_calls = toolCalls.map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (turnReasoning.length > 0) {
      assistantRecord._reasoning = turnReasoning;
    }
    messages.push(assistantMsg);

    // ── Post-turn validation ────────────────────────────────────────────
    // Before letting the turn end, run a layered set of detectors to catch
    // incomplete-turn patterns: planning-only, one-tool-then-stop, reasoning
    // without visible text, empty response, uncommitted turn, evidence
    // staleness. Each detector has its own retry budget; the first one that
    // fires and has budget left injects a nudge into the next attempt's
    // system prompt and continues the loop.
    {
      evidenceHistory.push(computeEvidenceCount(messages));
      const detectorState = {
        assistantText: assistantContent,
        toolCallsThisIteration: toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
        toolsCalledThisTurn,
        hasReasoning: turnReasoning.length > 0,
        completionTokens: totalOutput,
        iteration,
        evidenceCount: evidenceHistory[evidenceHistory.length - 1],
        evidenceHistory: [...evidenceHistory],
      };
      const hit = runPostTurnDetectors(detectorState, retryCounters);
      if (hit && iteration < maxIterations - 1) {
        console.warn(`[agent] Post-turn detector fired (Codex): ${hit.kind}`);
        try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "codex", model, detail: { reason: `post-turn-${hit.kind}` } })).catch(() => {}); } catch {}
        promptLayers.retry = hit;
        // Kick the Codex incremental-response path back to full context
        previousResponseId = undefined;
        lastContextLength = 0;
        continue;
      }
      // Clear any stale retry layer now that the turn is finishing cleanly
      promptLayers.retry = undefined;
    }

    if (toolCalls.length === 0) {
      const branch = handleNoToolCallBranch({
        assistantContent,
        messages,
        iteration,
        maxIterations,
        toolsCalledThisTurn,
        unmatchedClaimNudged,
        selfCheckFired,
      });
      unmatchedClaimNudged = branch.unmatchedClaimNudged;
      selfCheckFired = branch.selfCheckFired;
      if (branch.shouldContinue) continue;

      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    // Loop detection
    const loopResult = checkToolLoops(toolCalls, loopState);
    if (loopResult.abort) {
      onEvent?.({ type: "stream", delta: loopResult.nudge || "" });
      return { messages, usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }
    if (loopResult.nudge) {
      messages.push({ role: "user", content: loopResult.nudge } as ChatCompletionMessageParam);
    }

    // Record tool names BEFORE execution — even if a call errors, it was
    // attempted, and the check cares about intent vs claim. Also update the
    // session turn-lock registry so other readers (session_status, 409
    // responses) see live progress.
    const { isCommittingTool: isCommitting } = await import("../committing-tool-check.js");
    const { markIteration: markTurnLockIteration } = await import("../session-turn-lock.js");
    const iterationToolNames: string[] = [];
    for (const tc of toolCalls) {
      toolsCalledThisTurn.add(tc.name);
      iterationToolNames.push(tc.name);
      if (isCommitting(tc.name)) committingToolsThisTurn.add(tc.name);
    }
    markTurnLockIteration(options.sessionId, iterationToolNames);

    let toolResults;
    try {
      toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal, messages);
    } catch (e) {
      console.error("[agent] Tool execution error (Codex):", (e as Error).message);
      toolResults = [{ role: "tool" as const, content: `Tool execution failed: ${(e as Error).message}`, tool_call_id: toolCalls[0]?.id || "unknown" }];
    }
    // Strip injected <system-reminder> / <system> / <human> tags out of every
    // tool result before handing them to the model. Web pages can smuggle fake
    // protocol frames through browser/web_fetch tool output.
    toolResults = toolResults.map(r => {
      if (r.role !== "tool" || typeof r.content !== "string") return r;
      return { ...r, content: stripSystemInjectionTags(r.content) };
    });
    messages.push(...toolResults);

    // Dead-end detection — after 3 empty/null results in a row, inject a
    // system nudge telling the agent to stop and re-plan with a different tool.
    for (const tr of toolResults) {
      const content = typeof tr.content === "string" ? tr.content : "";
      const toolName = toolCalls.find(tc => tc.id === (tr as { tool_call_id?: string }).tool_call_id)?.name || "unknown";
      const d = checkDeadEnd(toolName, content, deadEndState);
      if (d.nudge) {
        messages.push({ role: "user", content: d.nudge } as ChatCompletionMessageParam);
        break;
      }
    }

    // Tightened pause detection: only trigger when the agent explicitly asks
    // the user for help, not when it's merely narrating that a site shows a
    // login screen. Previously this fired on phrases like "the page says login
    // required" and interrupted the agent's own flow.
    if (assistantContent && /\b(please (log in|sign in|enter|provide|confirm)|need(s)? you to|waiting for you|i need your|can you (log in|sign in|paste|approve)|blocked\s+on\s+(2fa|captcha|payment))\b/i.test(assistantContent)) {
      if (options.pauseCallback) {
        onEvent?.({ type: "stream", delta: "\n\n[Waiting for user input...]" });
        const userResponse = await options.pauseCallback(assistantContent);
        messages.push({ role: "user", content: userResponse });
        continue;
      }
    }
  }

  return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "max_iterations" };
}
