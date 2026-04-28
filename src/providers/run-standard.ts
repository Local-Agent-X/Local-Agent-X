import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../types.js";
import { executeToolCalls, toolsToOpenAI, checkAndCompact } from "../tool-executor.js";
import { getRuntimeConfig } from "../config.js";
import { detectUnresolvedErrors, buildReflectionPrompt, checkApprovalHallucination, checkCreationHallucination, checkUnmatchedActionClaim, checkToolLoops, createLoopState, checkDeadEnd, createDeadEndState } from "../agent-guards.js";
import { stripEphemeralMessages, sanitizeToolResults } from "./sanitize.js";
import { _localNoToolModels, type AgentOptions } from "./types.js";
import { buildUserContentWithImages, checkStandardTurnSafetyCeilings } from "./run-standard-helpers.js";
import { logRetry } from "../retry-telemetry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("providers.run-standard");

// ── Standard (xAI/OpenAI API) Agent Loop ──

export async function runStandardAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const {
    apiKey,
    model,
    systemPrompt,
    tools,
    security,
    maxIterations = 160,
    temperature = 0.7,
    onEvent,
    signal,
  } = options;

  const providerURLs: Record<string, string> = {
    local: `${getRuntimeConfig().ollamaUrl}/v1`,
    xai: "https://api.x.ai/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
    openai: "https://api.openai.com/v1",
    codex: "https://api.openai.com/v1",
    anthropic: "https://api.openai.com/v1",
    custom: "https://api.openai.com/v1",
  };
  const baseURL = options.baseURL || providerURLs[options.provider] || "https://api.openai.com/v1";
  const client = new OpenAI({ apiKey, baseURL });
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build user message — include images as vision content parts if present
  const userContent = await buildUserContentWithImages(userMessage, options.images);

  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userContent } as ChatCompletionMessageParam,
  ];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const loopState = createLoopState();
  const deadEndState = createDeadEndState();
  let selfCheckFired = false;
  // Tool-verified action-claim check state (see agent-guards.checkUnmatchedActionClaim)
  const toolsCalledThisTurn = new Set<string>();
  let unmatchedClaimNudged = false;
  // Post-turn validation state
  const { createRetryCounters, runPostTurnDetectors, computeEvidenceCount, userMessageHasImages } =
    await import("../agent-loop-detectors.js");
  const { createPromptLayers, composeSystemPrompt, isAckMessage, ACK_FAST_PATH_INSTRUCTION } =
    await import("../agent-loop-prompt-layers.js");
  const retryCounters = createRetryCounters();
  const promptLayers = createPromptLayers();
  const evidenceHistory: number[] = [];
  if (isAckMessage(userMessage)) {
    promptLayers.ackFastPath = ACK_FAST_PATH_INSTRUCTION;
  }

  // Force tool use on first iteration for build/action intents
  const BUILD_INTENT_RE = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
  const ACTION_INTENT_RE = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;
  const shouldForceTools = BUILD_INTENT_RE.test(userMessage) || ACTION_INTENT_RE.test(userMessage);

  // Per-turn safety ceilings (see agent-codex.ts for rationale)
  const TURN_TOKEN_CEILING = 500_000;
  const TURN_WALL_CLOCK_MS = 180_000;
  const MID_TURN_MIN_ITERATION = 5;
  const MID_TURN_EVIDENCE_STALE_WINDOW = 3;
  const turnStartMs = Date.now();
  const committingToolsThisTurn = new Set<string>();
  const { startHeartbeat: startHeartbeatStd } = await import("../session-heartbeat.js");
  const heartbeatStd = startHeartbeatStd({ sessionId: options.sessionId, onEvent, turnStartMs });
  const { onTurnRelease: onTurnReleaseStd } = await import("../session-turn-lock.js");
  onTurnReleaseStd(options.sessionId, () => heartbeatStd.stop());

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const ceilingHit = checkStandardTurnSafetyCeilings({
      messages,
      totalPromptTokens,
      totalCompletionTokens,
      turnStartMs,
      iteration,
      committingToolsThisTurn,
      evidenceHistory,
      options,
      model,
      tokenCeiling: TURN_TOKEN_CEILING,
      wallClockMs: TURN_WALL_CLOCK_MS,
      midTurnMinIteration: MID_TURN_MIN_ITERATION,
      midTurnEvidenceStaleWindow: MID_TURN_EVIDENCE_STALE_WINDOW,
    });
    if (ceilingHit) return ceilingHit;

    if (iteration > 0) messages = stripEphemeralMessages(messages);
    messages = checkAndCompact(messages, model, onEvent);

    // Re-compose system prompt with any active retry/ack layers. This layer
    // gets refreshed every iteration — fresh nudges appear, resolved ones
    // disappear — so the model only sees the instruction relevant to NOW.
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0] = { role: "system", content: composeSystemPrompt(systemPrompt, promptLayers) };
    }

    // Drain subagent completion queue — inject any pending subagent results as
    // a synthetic user message so the parent doesn't need to poll agent_status.
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
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "abort",
      };
    }

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    try {
      const useTools = !_localNoToolModels.has(model);
      // tool_choice: "required" disabled — causes empty responses on some models (Grok, Codex)
      // Enable reasoning on models that support it. Chat-only models (grok-3-mini,
      // gpt-4o, gemini-2.0-flash) would 400 if we sent reasoning_effort, so match
      // by name pattern and only opt in for known reasoning-capable models.
      // grok-4 uses reasoning natively but rejects the `reasoningEffort`
      // parameter ("Model grok-4 does not support parameter reasoningEffort").
      // Only grok-3-mini-reasoning accepts the OpenAI-style reasoning_effort on xAI.
      const reasoningCapable = /grok-3-mini-reasoning|^o[134]|gpt-5|gemini-(2\.5|3)|deepseek-r1|qwen.*reasoning/i.test(model);
      let stream = await client.chat.completions.create({
        model,
        messages,
        ...(useTools ? { tools: toolsToOpenAI(tools) } : {}),
        temperature,
        stream: true,
        ...(reasoningCapable ? { reasoning_effort: "medium" as const } : {}),
      }, { signal: signal || undefined }).catch(async (err: Error) => {
        if (options.provider === "local" && err.message?.includes("does not support tools")) {
          _localNoToolModels.add(model);
          logger.info(`[agent] Model ${model} doesn't support tools — switching to chat-only mode`);
          return client.chat.completions.create({
            model,
            messages,
            temperature,
            stream: true,
          }, { signal: signal || undefined });
        }
        throw err;
      });

      let finishReason: string | undefined;
      for await (const chunk of stream) {
        if (signal?.aborted) {
          stream.controller.abort();
          break;
        }
        const choice = chunk.choices[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantContent += delta.content;
          onEvent?.({ type: "stream", delta: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              while (toolCalls.length <= tc.index) {
                toolCalls.push({ id: "", name: "", arguments: "" });
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
            }
          }
        }

        if (chunk.usage) {
          totalPromptTokens += chunk.usage.prompt_tokens || 0;
          totalCompletionTokens += chunk.usage.completion_tokens || 0;
        }
      }

      // Classify the response
      const { classifyOpenAIResponse, logClassification } = await import("../response-classifier.js");
      const classification = classifyOpenAIResponse({
        hasText: !!assistantContent.trim(),
        hasToolCalls: toolCalls.length > 0,
        finishReason,
        inputTokens: totalPromptTokens,
        outputTokens: totalCompletionTokens,
      });
      logClassification(options.provider, model, classification);
    } catch (e) {
      const errMsg = (e as Error).message || "Stream error";
      // Context overflow: force-compact aggressively and continue the loop
      // instead of bailing. The model hit its window — keep the last couple
      // of turns and an auto-generated summary, then retry this iteration.
      const { isContextOverflowError, forceCompact } = await import("../context-manager.js");
      if (isContextOverflowError(e) && iteration < maxIterations - 1) {
        const before = messages.length;
        messages = forceCompact(messages, 2);
        logger.warn(`[agent] Context overflow — force-compacted ${before} → ${messages.length} msgs and retrying`);
        logRetry({ kind: "context-overflow", sessionId: options.sessionId, detail: { provider: options.provider, model, before, after: messages.length } });
        onEvent?.({ type: "context_status", percentage: 100, level: "emergency", usedTokens: 0, maxTokens: 0, compacted: true });
        continue;
      }
      logger.error("[agent] Standard stream error:", errMsg);
      const { classifyOpenAIResponse, logClassification } = await import("../response-classifier.js");
      const classification = classifyOpenAIResponse({
        hasText: !!assistantContent.trim(),
        hasToolCalls: toolCalls.length > 0,
        errorMessage: errMsg,
      });
      logClassification(options.provider, model, classification);
      onEvent?.({ type: "error", message: errMsg });
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "error",
        errorMessage: errMsg,
      };
    }

    const assistantMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: assistantContent || null,
    };
    if (toolCalls.length > 0) {
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    // Post-turn validation phase — run the layered detectors for incomplete
    // turns (planning-only, single-action-stop, reasoning-only, empty
    // response, uncommitted turn, evidence staleness). First hit with budget
    // remaining injects a nudge and continues.
    {
      evidenceHistory.push(computeEvidenceCount(messages));
      const detectorState = {
        assistantText: assistantContent,
        toolCallsThisIteration: toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
        toolsCalledThisTurn,
        hasReasoning: false,
        completionTokens: totalCompletionTokens,
        iteration,
        evidenceCount: evidenceHistory[evidenceHistory.length - 1],
        evidenceHistory: [...evidenceHistory],
        userMessageHasImages: userMessageHasImages(messages as Array<{ role: string; content: unknown }>),
      };
      const hit = runPostTurnDetectors(detectorState, retryCounters);
      if (hit && iteration < maxIterations - 1) {
        logger.warn(`[agent] Post-turn detector fired: ${hit.kind}`);
        logRetry({ kind: "custom", sessionId: options.sessionId, provider: options.provider, model, detail: { reason: `post-turn-${hit.kind}` } });
        promptLayers.retry = hit;
        continue;
      }
      promptLayers.retry = undefined;
    }

    if (toolCalls.length === 0) {
      // Approval hallucination
      const approvalNudge = checkApprovalHallucination(assistantContent);
      if (approvalNudge && iteration < maxIterations - 1) {
        logger.warn(`[agent] Approval hallucination detected — nudging`);
        messages.push({ role: "user", content: approvalNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Creation hallucination
      const creationNudge = checkCreationHallucination(assistantContent);
      if (creationNudge && iteration === 0) {
        logger.warn(`[agent] Creation hallucination detected — nudging`);
        messages.push({ role: "user", content: creationNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Tool-verified action-claim check
      if (!unmatchedClaimNudged && iteration < maxIterations - 1) {
        const claimNudge = checkUnmatchedActionClaim(assistantContent, toolsCalledThisTurn);
        if (claimNudge) {
          logger.warn(`[agent] Unmatched action claim detected — nudging`);
          unmatchedClaimNudged = true;
          messages.push({ role: "user", content: claimNudge } as ChatCompletionMessageParam);
          continue;
        }
      }

      // Self-check: unresolved tool errors (cap at one per run)
      const unresolvedErrors = !selfCheckFired ? detectUnresolvedErrors(messages) : [];
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
        selfCheckFired = true;
        messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
        continue;
      }

      onEvent?.({
        type: "done",
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
      });
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "end_turn",
      };
    }

    // Loop detection — tighter thresholds for weak/medium models
    const { classifyModel } = await import("../model-tiers.js");
    const modelTier = classifyModel(model);
    const loopResult = checkToolLoops(toolCalls, loopState, { modelTier });
    if (loopResult.abort) {
      onEvent?.({ type: "stream", delta: loopResult.nudge || "" });
      return { messages, usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens }, stopReason: "end_turn" };
    }
    if (loopResult.nudge) {
      messages.push({ role: "user", content: loopResult.nudge } as ChatCompletionMessageParam);
    }

    // Record attempted tool names for the action-claim check + update the
    // session turn-lock registry with live progress.
    const { isCommittingTool: isCommittingStd } = await import("../committing-tool-check.js");
    const { markIteration: markTurnLockStd } = await import("../session-turn-lock.js");
    const iterationToolNamesStd: string[] = [];
    for (const tc of toolCalls) {
      toolsCalledThisTurn.add(tc.name);
      iterationToolNamesStd.push(tc.name);
      if (isCommittingStd(tc.name)) committingToolsThisTurn.add(tc.name);
    }
    markTurnLockStd(options.sessionId, iterationToolNamesStd);

    let toolResults;
    try {
      toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal, messages);
    } catch (e) {
      logger.error("[agent] Tool execution error (Standard):", (e as Error).message);
      toolResults = [{ role: "tool" as const, content: `Tool execution failed: ${(e as Error).message}`, tool_call_id: toolCalls[0]?.id || "unknown" }];
    }
    toolResults = sanitizeToolResults(toolResults);
    messages.push(...toolResults);

    // Dead-end detection — 3 empty results in a row → nudge a re-plan
    for (const tr of toolResults) {
      const content = typeof tr.content === "string" ? tr.content : "";
      const toolName = toolCalls.find(tc => tc.id === (tr as { tool_call_id?: string }).tool_call_id)?.name || "unknown";
      const d = checkDeadEnd(toolName, content, deadEndState);
      if (d.nudge) {
        messages.push({ role: "user", content: d.nudge } as ChatCompletionMessageParam);
        break;
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

  return {
    messages,
    usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
    stopReason: "max_iterations",
  };
}
