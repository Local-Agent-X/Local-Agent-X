import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../types.js";
import { streamAnthropicResponse } from "../anthropic-client.js";
import { executeToolCalls, checkAndCompact } from "../tool-executor.js";
import { detectUnresolvedErrors, buildReflectionPrompt, checkApprovalHallucination, checkCreationHallucination, checkUnmatchedActionClaim, checkToolLoops, createLoopState, checkDeadEnd, createDeadEndState, checkPostCommit } from "../agent-guards.js";
import { stripEphemeralMessages, sanitizeToolResults } from "./sanitize.js";
import type { AgentOptions } from "./types.js";
import { detectBuildIntent, extractAppName, extractBuildPrompt } from "./build-intent.js";
import { buildAnthropicUserContent, checkAnthropicTurnSafetyCeilings } from "./run-anthropic-helpers.js";
import { logRetry } from "../retry-telemetry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("providers.run-anthropic");

// ── Anthropic (Claude) Agent Loop ──

export async function runAnthropicAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const { apiKey, model, systemPrompt, tools, security, maxIterations = 160, temperature = 0.7, onEvent, signal } = options;
  const toolMap = new Map(tools.map(t => [t.name, t]));

  // Build user message — attach images as vision parts when present.
  // Anthropic accepts OpenAI-style content arrays; anthropic-client.convertUserContent
  // translates image_url data URLs to Anthropic's base64 image format.
  const userContent = await buildAnthropicUserContent(userMessage, options.images);

  let messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: userContent } as ChatCompletionMessageParam,
  ];

  let totalInput = 0, totalOutput = 0;
  let selfCheckFiredAnthropic = false;
  const loopStateAnthropic = createLoopState();
  const deadEndStateAnthropic = createDeadEndState();
  // Tool-verified action-claim check state
  const toolsCalledThisTurnAnthropic = new Set<string>();
  let unmatchedClaimNudgedAnthropic = false;
  // Post-turn validation state
  const retryCountersAnthropic = (await import("../agent-loop-detectors.js")).createRetryCounters();
  const promptLayersAnthropic = (await import("../agent-loop-prompt-layers.js")).createPromptLayers();
  const evidenceHistoryAnthropic: number[] = [];
  {
    const { isAckMessage, ACK_FAST_PATH_INSTRUCTION, isWebsiteBuildIntent, WEBSITE_BUILDER_INSTRUCTION } = await import("../agent-loop-prompt-layers.js");
    if (isAckMessage(userMessage)) promptLayersAnthropic.ackFastPath = ACK_FAST_PATH_INSTRUCTION;
    if (isWebsiteBuildIntent(userMessage)) promptLayersAnthropic.websiteBuilder = WEBSITE_BUILDER_INSTRUCTION;
  }
  const anthropicTools = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

  // Force tool use on first iteration for build/action intents
  const BUILD_INTENT_RE_A = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
  const ACTION_INTENT_RE_A = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;
  const shouldForceToolsA = BUILD_INTENT_RE_A.test(userMessage) || ACTION_INTENT_RE_A.test(userMessage);

  // Per-turn safety ceilings (Anthropic path) — mirror of standard/codex
  const TURN_TOKEN_CEILING_A = 500_000;
  const TURN_WALL_CLOCK_MS_A = 180_000;
  const MID_TURN_MIN_ITERATION_A = 5;
  const MID_TURN_EVIDENCE_STALE_WINDOW_A = 3;
  const turnStartMsA = Date.now();
  const committingToolsThisTurnA = new Set<string>();
  const { startHeartbeat: startHeartbeatA } = await import("../session-heartbeat.js");
  const heartbeatA = startHeartbeatA({ sessionId: options.sessionId, onEvent, turnStartMs: turnStartMsA });
  const { onTurnRelease: onTurnReleaseA } = await import("../session-turn-lock.js");
  onTurnReleaseA(options.sessionId, () => heartbeatA.stop());

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const ceilingHit = checkAnthropicTurnSafetyCeilings({
      messages,
      systemPrompt,
      totalInput,
      totalOutput,
      turnStartMs: turnStartMsA,
      iteration,
      committingToolsThisTurn: committingToolsThisTurnA,
      evidenceHistory: evidenceHistoryAnthropic,
      options,
      model,
      tokenCeiling: TURN_TOKEN_CEILING_A,
      wallClockMs: TURN_WALL_CLOCK_MS_A,
      midTurnMinIteration: MID_TURN_MIN_ITERATION_A,
      midTurnEvidenceStaleWindow: MID_TURN_EVIDENCE_STALE_WINDOW_A,
    });
    if (ceilingHit) return ceilingHit;

    if (iteration > 0) messages = stripEphemeralMessages(messages);
    messages = checkAndCompact(messages, model, onEvent);

    // Drain subagent completion queue (see standard loop for rationale)
    if (options.sessionId) {
      try {
        const { drainCompletions, formatCompletionMessage } = await import("../agency/completion-queue.js");
        const notices = drainCompletions(options.sessionId);
        if (notices.length > 0) {
          messages.push({ role: "user", content: formatCompletionMessage(notices) } as ChatCompletionMessageParam);
        }
      } catch {}
    }

    if (signal?.aborted) {
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };
    }

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    const { composeSystemPrompt: composeA } = await import("../agent-loop-prompt-layers.js");
    const layeredSystemPromptA = composeA(systemPrompt, promptLayersAnthropic);

    const stream = streamAnthropicResponse({
      token: apiKey,
      model,
      messages,
      systemPrompt: layeredSystemPromptA,
      tools: anthropicTools,
      temperature,
      toolChoice: (iteration === 0 && shouldForceToolsA) ? "required" : "auto",
      sessionId: options.sessionId,
      // Forward the abort signal so a user-initiated stop kills the spawned
      // `claude` subprocess (stream-cli wires this to SIGTERM + SIGKILL fallback).
      // Without this, stop only halts the JS-side stream consumer; the CLI
      // process keeps running tool calls in the background.
      signal,
    });

    let streamError: string | null = null;
    let sawMcpActivity = false;
    for await (const event of stream) {
      if (event.type === "text") {
        assistantContent += event.delta;
        onEvent?.({ type: "stream", delta: event.delta || "" });
      } else if (event.type === "tool_call") {
        toolCalls.push({ id: event.id!, name: event.name!, arguments: event.arguments! });
        toolsCalledThisTurnAnthropic.add(event.name!);
      } else if ((event as { type?: string }).type === "mcp_activity") {
        // Tools executed end-to-end via the MCP bridge — no local re-execution
        // needed. Flag so the auto-route fallback below doesn't trigger.
        sawMcpActivity = true;
        // Capture MCP tool names for the action-claim check AND the turn-lock
        // registry. They come through as "mcp__lax__bash" etc; strip the
        // prefix so the check can match against our verb→tool mapping.
        // (Matcher is prefix-agnostic via /^mcp__[^_]+__/ so legacy sessions
        // still using mcp__sax__ also work during the rebrand window.)
        const mcpName = (event as { name?: string }).name || "";
        const plain = mcpName.replace(/^mcp__[^_]+__/, "");
        if (plain) {
          toolsCalledThisTurnAnthropic.add(plain);
          try {
            const { isCommittingTool } = await import("../committing-tool-check.js");
            if (isCommittingTool(plain)) committingToolsThisTurnA.add(plain);
            const { markIteration } = await import("../session-turn-lock.js");
            markIteration(options.sessionId, [plain]);
          } catch {}
          // Forward as a tool_start + tool_end pair so the worker's onEvent
          // handler emits a tool_call event the session bridge can route as
          // bg_op_progress. Without this, the AGENTS sidebar stays dark for
          // Anthropic workers (MCP tool calls execute inside the CLI subprocess
          // and never produce visible side-effects in the worker's stream).
          // We fire both events synchronously because by the time mcp_activity
          // arrives, the MCP bridge has already executed the tool — there's
          // no "in flight" state to model.
          let parsedArgs: unknown = {};
          try { parsedArgs = JSON.parse((event as { arguments?: string }).arguments || "{}"); } catch {}
          const tcId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          onEvent?.({ type: "tool_start", toolName: plain, toolCallId: tcId, args: parsedArgs });
          onEvent?.({ type: "tool_end", toolName: plain, toolCallId: tcId, result: "(handled by MCP bridge)", allowed: true });
        }
      } else if (event.type === "done") {
        totalInput += event.usage?.inputTokens || 0;
        totalOutput += event.usage?.outputTokens || 0;
      } else if (event.type === "error") {
        streamError = event.error || "Anthropic error";
        onEvent?.({ type: "error", message: streamError });
      }
    }
    if (streamError) {
      const { isContextOverflowError, forceCompact } = await import("../context-manager.js");
      if (isContextOverflowError(streamError) && iteration < maxIterations - 1) {
        const before = messages.length;
        messages = forceCompact(messages, 2);
        logger.warn(`[agent] Anthropic context overflow — force-compacted ${before} → ${messages.length} msgs and retrying`);
        logRetry({ kind: "context-overflow", sessionId: options.sessionId, detail: { provider: "anthropic", model, before, after: messages.length } });
        onEvent?.({ type: "context_status", percentage: 100, level: "emergency", usedTokens: 0, maxTokens: 0, compacted: true });
        continue;
      }
      return { messages, usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "error", errorMessage: streamError || undefined };
    }

    const assistantMsg: ChatCompletionMessageParam = { role: "assistant", content: assistantContent || null };
    if (toolCalls.length > 0) {
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map(tc => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    // Auto-route to build_app if Claude tried to write files directly (skip for IDE sessions).
    // Skip the auto-route when MCP tool calls already ran — Claude did the
    // work through the bridge; the toolCalls array is intentionally empty.
    const hasBuildApp = tools.some(t => t.name === "build_app");
    if (toolCalls.length === 0 && !sawMcpActivity && hasBuildApp && detectBuildIntent(assistantContent, userMessage)) {
      const appName = extractAppName(assistantContent, userMessage);
      const buildPrompt = extractBuildPrompt(assistantContent, userMessage);
      logger.info(`[agent] Auto-routing to build_app: ${appName}`);
      onEvent?.({ type: "stream", delta: "\n\n*Building app...*\n" });
      toolCalls.push({
        id: `call_${Date.now()}_build_app`,
        name: "build_app",
        arguments: JSON.stringify({ name: appName, prompt: buildPrompt }),
      });
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map(tc => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    // Post-turn validation phase (same detector stack as the standard loop)
    {
      const { runPostTurnDetectors: runA, computeEvidenceCount: evidenceA, userMessageHasImages: hasImgsA } =
        await import("../agent-loop-detectors.js");
      evidenceHistoryAnthropic.push(evidenceA(messages));
      const detectorStateA = {
        assistantText: assistantContent,
        toolCallsThisIteration: toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
        toolsCalledThisTurn: toolsCalledThisTurnAnthropic,
        hasReasoning: false,
        completionTokens: totalOutput,
        iteration,
        evidenceCount: evidenceHistoryAnthropic[evidenceHistoryAnthropic.length - 1],
        evidenceHistory: [...evidenceHistoryAnthropic],
        userMessageHasImages: hasImgsA(messages as Array<{ role: string; content: unknown }>),
      };
      const hitA = runA(detectorStateA, retryCountersAnthropic);
      if (hitA && iteration < maxIterations - 1) {
        logger.warn(`[agent] Post-turn detector fired (Anthropic): ${hitA.kind}`);
        logRetry({ kind: "custom", sessionId: options.sessionId, provider: "anthropic", model, detail: { reason: `post-turn-${hitA.kind}` } });
        promptLayersAnthropic.retry = hitA;
        continue;
      }
      promptLayersAnthropic.retry = undefined;
    }

    // Tool-verified action-claim check runs BEFORE the MCP-exit shortcut so
    // hallucinations over the MCP bridge ("I saved the image to the app
    // folder" without actually calling write/bash/mv) still get caught.
    if (toolCalls.length === 0 && !unmatchedClaimNudgedAnthropic && iteration < maxIterations - 1) {
      const claimNudge = checkUnmatchedActionClaim(assistantContent, toolsCalledThisTurnAnthropic);
      if (claimNudge) {
        logger.warn(`[agent] Unmatched action claim detected (Anthropic) — nudging`);
        unmatchedClaimNudgedAnthropic = true;
        messages.push({ role: "user", content: claimNudge } as ChatCompletionMessageParam);
        continue;
      }
    }

    // MCP path: tools already ran inside Claude CLI — we're done.
    if (toolCalls.length === 0 && sawMcpActivity) {
      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    if (toolCalls.length === 0 && !sawMcpActivity) {
      // Only check for hallucinations when no tools were called at all.
      const approvalNudge = checkApprovalHallucination(assistantContent);
      if (approvalNudge && iteration < maxIterations - 1) {
        logger.warn(`[agent] Approval hallucination detected (Anthropic) — nudging`);
        messages.push({ role: "user", content: approvalNudge } as ChatCompletionMessageParam);
        continue;
      }

      const creationNudge = checkCreationHallucination(assistantContent);
      if (creationNudge && iteration === 0) {
        logger.warn(`[agent] Creation hallucination detected (Anthropic) — nudging`);
        messages.push({ role: "user", content: creationNudge } as ChatCompletionMessageParam);
        continue;
      }

      const unresolvedErrors = !selfCheckFiredAnthropic ? detectUnresolvedErrors(messages) : [];
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
        selfCheckFiredAnthropic = true;
        messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
        continue;
      }

      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    // Loop detection
    const loopResult = checkToolLoops(toolCalls, loopStateAnthropic);
    if (loopResult.abort) {
      onEvent?.({ type: "stream", delta: loopResult.nudge || "" });
      return { messages, usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }
    if (loopResult.nudge) {
      messages.push({ role: "user", content: loopResult.nudge } as ChatCompletionMessageParam);
    }

    // Record attempted tool names for the action-claim check + update the
    // session turn-lock registry with live progress (Anthropic path).
    const { isCommittingTool: isCommittingA } = await import("../committing-tool-check.js");
    const { markIteration: markTurnLockA } = await import("../session-turn-lock.js");
    const iterationToolNamesA: string[] = [];
    for (const tc of toolCalls) {
      toolsCalledThisTurnAnthropic.add(tc.name);
      iterationToolNamesA.push(tc.name);
      if (isCommittingA(tc.name)) committingToolsThisTurnA.add(tc.name);
    }
    markTurnLockA(options.sessionId, iterationToolNamesA);

    let toolResults;
    try {
      toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal, messages);
    } catch (e) {
      logger.error("[agent] Tool execution error (Anthropic):", (e as Error).message);
      toolResults = [{ role: "tool" as const, content: `Tool execution failed: ${(e as Error).message}`, tool_call_id: toolCalls[0]?.id || "unknown" }];
    }
    toolResults = sanitizeToolResults(toolResults);
    messages.push(...toolResults);

    // Dead-end detection — 3 empty results in a row → nudge a re-plan
    for (const tr of toolResults) {
      const content = typeof tr.content === "string" ? tr.content : "";
      const toolName = toolCalls.find(tc => tc.id === (tr as { tool_call_id?: string }).tool_call_id)?.name || "unknown";
      const d = checkDeadEnd(toolName, content, deadEndStateAnthropic);
      if (d.nudge) {
        messages.push({ role: "user", content: d.nudge } as ChatCompletionMessageParam);
        break;
      }
    }

    // Post-commit nudge — if any bash result this iteration emitted a successful
    // git-commit signature, set a flag and inject a wrap-up nudge on the NEXT
    // iteration. Stops the perma-fix-mandate sprawl that follows a real ship.
    {
      const flatResults = toolResults.map(tr => ({
        name: toolCalls.find(tc => tc.id === (tr as { tool_call_id?: string }).tool_call_id)?.name || "unknown",
        result: typeof tr.content === "string" ? tr.content : "",
      }));
      const pc = checkPostCommit(flatResults, loopStateAnthropic);
      if (pc.nudge) {
        messages.push({ role: "user", content: pc.nudge } as ChatCompletionMessageParam);
      }
    }

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
