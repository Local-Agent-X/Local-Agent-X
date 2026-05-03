/**
 * runAgentTurn — the unified agent loop. Replaces the per-provider
 * loops (run-standard / run-anthropic / run-codex/run-http) with a
 * single body that drives any registered adapter through the
 * normalized StreamChunk contract, with composable middlewares at
 * three hook points.
 *
 * Phase 1 scope: infrastructure middlewares only (token/wall-clock
 * ceilings, mid-turn-stale, subagent drain, heartbeat). Behavior
 * middlewares (post-turn detectors, hallucination checks, action-claim
 * verification, loop detection, dead-end detection, post-commit nudge)
 * land in Phase 2.
 *
 * Until the full middleware stack is in place, this loop behaves like
 * a degraded version of run-standard: no hallucination guards, no
 * dead-end detection. Gated behind LAX_UNIFIED_LOOP=1 so production
 * traffic stays on the legacy loops.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../types.js";
import type {
  AgentTurnRequest,
  LoopContext,
  LoopMiddleware,
  MiddlewareResult,
  ModelCallResult,
} from "./types.js";
import { requireAdapter } from "../providers/adapter/registry.js";
import { executeToolCalls, checkAndCompact } from "../tool-executor.js";
import { stripEphemeralMessages, sanitizeToolResults } from "../providers/sanitize.js";
import { buildUserContentWithImages } from "../providers/run-standard-helpers.js";
import { createLogger } from "../logger.js";
import { getDefaultMiddlewareStack } from "./registry.js";
// Side-effect import — registers all built-in adapters at boot.
import "../providers/adapters/index.js";

const logger = createLogger("agent-loop.run");

/**
 * Resolve the adapter name from provider + auth signal. Matches the
 * routing already encoded in agent.ts + each legacy loop, but in one
 * place. Anthropic CLI vs HTTP is decided by token shape.
 */
async function resolveAdapterName(req: AgentTurnRequest): Promise<string> {
  switch (req.provider) {
    case "anthropic": {
      const { usesAnthropicSubscriptionAuth } = await import("../anthropic-models.js");
      return (req.apiKey === "cli" || usesAnthropicSubscriptionAuth(req.apiKey))
        ? "anthropic-cli"
        : "anthropic-http";
    }
    case "codex":
      return "codex-cli";
    case "local":
      return "ollama-http";
    default:
      // openai, xai, gemini, custom — all OpenAI Chat Completions shape
      return "openai-http";
  }
}

/**
 * Walk middlewares for one phase. Stops at the first non-"continue"
 * result. The caller dispatches on `kind` to handle nudge/abort/retry.
 */
async function runPhase(
  middlewares: LoopMiddleware[],
  phase: "beforeIteration" | "afterModelCall" | "afterToolExecution",
  ctx: LoopContext,
  modelResult?: ModelCallResult,
  toolResults?: ChatCompletionMessageParam[],
): Promise<MiddlewareResult & { firedBy?: string }> {
  for (const mw of middlewares) {
    const hook = mw[phase];
    if (!hook) continue;
    let res: MiddlewareResult;
    if (phase === "beforeIteration") {
      res = await (hook as NonNullable<LoopMiddleware["beforeIteration"]>)(ctx);
    } else if (phase === "afterModelCall") {
      res = await (hook as NonNullable<LoopMiddleware["afterModelCall"]>)(ctx, modelResult!);
    } else {
      res = await (hook as NonNullable<LoopMiddleware["afterToolExecution"]>)(ctx, toolResults!);
    }
    if (res.kind !== "continue") return { ...res, firedBy: mw.name };
  }
  return { kind: "continue" };
}

export async function runAgentTurn(req: AgentTurnRequest): Promise<AgentTurn> {
  const {
    userMessage,
    history,
    systemPrompt,
    tools,
    security,
    maxIterations = 160,
    onEvent,
    signal,
  } = req;

  const toolMap = new Map(tools.map(t => [t.name, t]));
  const userContent = await buildUserContentWithImages(userMessage, req.images);

  const adapterName = await resolveAdapterName(req);
  const adapter = requireAdapter(adapterName);

  // Filter middlewares by `when` predicate so per-provider extras are
  // gated without runtime checks inside the hook bodies.
  const allMiddlewares = getDefaultMiddlewareStack();
  const middlewares = allMiddlewares.filter(m => !m.when || m.when(req));

  // Compose system prompt layers (ack-fast-path, website-builder).
  const { createPromptLayers, composeSystemPrompt, isAckMessage, ACK_FAST_PATH_INSTRUCTION, isWebsiteBuildIntent, WEBSITE_BUILDER_INSTRUCTION } =
    await import("../agent-loop-prompt-layers.js");
  const promptLayers = createPromptLayers();
  if (isAckMessage(userMessage)) promptLayers.ackFastPath = ACK_FAST_PATH_INSTRUCTION;
  if (isWebsiteBuildIntent(userMessage)) promptLayers.websiteBuilder = WEBSITE_BUILDER_INSTRUCTION;

  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userContent } as ChatCompletionMessageParam,
  ];

  const ctx: LoopContext = {
    req,
    iteration: 0,
    messages,
    totalInput: 0,
    totalOutput: 0,
    turnStartMs: Date.now(),
    toolsCalledThisTurn: new Set(),
    committingToolsThisTurn: new Set(),
    evidenceHistory: [],
    promptLayers,
    adapter,
    providerState: {},
    assistantContent: "",
    toolCalls: [],
    sawMcpActivity: false,
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    ctx.iteration = iteration;
    ctx.messages = messages;

    if (signal?.aborted) {
      return abortTurn(ctx);
    }

    // ── Phase: beforeIteration ──
    const beforeRes = await runPhase(middlewares, "beforeIteration", ctx);
    if (beforeRes.kind === "abort") return beforeRes.turn;
    if (beforeRes.kind === "nudge") {
      messages.push({ role: "user", content: beforeRes.message } as ChatCompletionMessageParam);
      continue;
    }
    if (beforeRes.kind === "retry-iteration") continue;

    if (iteration > 0) messages = stripEphemeralMessages(messages);
    messages = checkAndCompact(messages, req.model, onEvent);

    // Refresh system message every iteration so prompt-layer changes
    // (retry nudges, etc.) propagate without restart.
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0] = { role: "system", content: composeSystemPrompt(systemPrompt, promptLayers) };
    }

    const composedSystemPrompt = (messages[0]?.role === "system" && typeof messages[0].content === "string")
      ? messages[0].content
      : systemPrompt;
    const restMessages = messages[0]?.role === "system" ? messages.slice(1) : messages;

    // ── Model call via adapter ──
    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let sawMcpActivity = false;
    let finishReason = "end_turn";
    let usagePrompt = 0, usageCompletion = 0;
    let streamError: string | null = null;

    try {
      // toolChoice can be set by force-tool-use middleware on iter 0 for
      // build/action intents. Reset between iterations so it doesn't stick
      // beyond the iteration where it was set.
      const turnToolChoice = (req as { toolChoice?: "auto" | "required" }).toolChoice;
      for await (const chunk of adapter.stream({
        apiKey: req.apiKey,
        model: req.model,
        baseURL: req.baseURL,
        systemPrompt: composedSystemPrompt,
        messages: restMessages,
        tools,
        temperature: req.temperature,
        toolChoice: turnToolChoice,
        sessionId: req.sessionId,
        signal: signal || undefined,
        onEvent,
        previousResponseId: ctx.providerState.previousResponseId as string | undefined,
      })) {
        if (signal?.aborted) break;
        switch (chunk.type) {
          case "text":
            assistantContent += chunk.delta;
            onEvent?.({ type: "stream", delta: chunk.delta });
            break;
          case "tool_call":
            toolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments });
            ctx.toolsCalledThisTurn.add(chunk.name);
            break;
          case "mcp_activity":
            sawMcpActivity = true;
            // Provider-specific MCP fan-out (Anthropic CLI) lands as
            // an adapter responsibility in Phase 3. For now the adapter
            // emits the chunk; the loop just records the flag.
            break;
          case "reasoning":
            // Codex reasoning items — store in providerState for the
            // adapter to thread back via previousResponseId.
            (ctx.providerState.turnReasoning ??= [] as unknown[]);
            (ctx.providerState.turnReasoning as unknown[]).push(chunk.item);
            break;
          case "image_generated":
            onEvent?.({ type: "image_generated", url: chunk.url, prompt: chunk.prompt });
            break;
          case "usage":
            usagePrompt = chunk.promptTokens;
            usageCompletion = chunk.completionTokens;
            break;
          case "done":
            finishReason = chunk.stopReason;
            if (chunk.responseId) ctx.providerState.previousResponseId = chunk.responseId;
            break;
          case "error":
            streamError = chunk.message;
            onEvent?.({ type: "error", message: chunk.message });
            break;
        }
      }
    } catch (e) {
      streamError = (e as Error).message || "Stream error";
      onEvent?.({ type: "error", message: streamError });
    }

    if (streamError) {
      const { isContextOverflowError, forceCompact } = await import("../context-manager.js");
      if (isContextOverflowError(streamError) && iteration < maxIterations - 1) {
        const before = messages.length;
        messages = forceCompact(messages, 2);
        ctx.providerState.previousResponseId = undefined;
        logger.warn(`context overflow — force-compacted ${before} -> ${messages.length} msgs`);
        onEvent?.({ type: "context_status", percentage: 100, level: "emergency", usedTokens: 0, maxTokens: 0, compacted: true });
        continue;
      }
      return {
        messages,
        usage: { promptTokens: ctx.totalInput, completionTokens: ctx.totalOutput, totalTokens: ctx.totalInput + ctx.totalOutput },
        stopReason: "error",
        errorMessage: streamError,
      };
    }

    ctx.totalInput += usagePrompt;
    ctx.totalOutput += usageCompletion;
    ctx.assistantContent = assistantContent;
    ctx.toolCalls = toolCalls;
    ctx.sawMcpActivity = sawMcpActivity;

    // ── Phase: afterModelCall ──
    // Run middlewares BEFORE pushing the assistant message so middlewares
    // (e.g. autoBuildApp) can mutate result.toolCalls — synthetic tool
    // calls land in the message we push below. Side effect: middlewares
    // can no longer read the assistant message from ctx.messages here
    // (they get it via result.assistantContent + result.toolCalls instead).
    const modelResult: ModelCallResult = {
      assistantContent, toolCalls, sawMcpActivity, finishReason,
    };
    const afterModelRes = await runPhase(middlewares, "afterModelCall", ctx, modelResult);

    // Build assistant message AFTER middleware so any synthetic tool calls
    // added by autoBuildApp etc. ride along.
    const assistantMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: assistantContent || null,
    };
    if (toolCalls.length > 0) {
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map(tc => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    if (afterModelRes.kind === "abort") return afterModelRes.turn;
    if (afterModelRes.kind === "nudge") {
      messages.push({ role: "user", content: afterModelRes.message } as ChatCompletionMessageParam);
      continue;
    }
    if (afterModelRes.kind === "retry-iteration") continue;

    // No tool calls + no MCP shortcut → end of turn.
    if (toolCalls.length === 0 && !sawMcpActivity) {
      onEvent?.({ type: "done", usage: { promptTokens: ctx.totalInput, completionTokens: ctx.totalOutput, totalTokens: ctx.totalInput + ctx.totalOutput } });
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages.slice(1)],
        usage: { promptTokens: ctx.totalInput, completionTokens: ctx.totalOutput, totalTokens: ctx.totalInput + ctx.totalOutput },
        stopReason: "end_turn",
      };
    }

    // MCP path: tools already ran via the bridge — wrap up.
    if (toolCalls.length === 0 && sawMcpActivity) {
      onEvent?.({ type: "done", usage: { promptTokens: ctx.totalInput, completionTokens: ctx.totalOutput, totalTokens: ctx.totalInput + ctx.totalOutput } });
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages.slice(1)],
        usage: { promptTokens: ctx.totalInput, completionTokens: ctx.totalOutput, totalTokens: ctx.totalInput + ctx.totalOutput },
        stopReason: "end_turn",
      };
    }

    // ── Tool execution ──
    let toolResults: ChatCompletionMessageParam[];
    try {
      toolResults = await executeToolCalls(
        toolCalls, toolMap, security, req.toolPolicy, req.threatEngine,
        req.rbac, req.callerRole, req.sessionId, onEvent, signal, messages,
      );
    } catch (e) {
      logger.error("tool execution error:", (e as Error).message);
      toolResults = [{
        role: "tool",
        content: `Tool execution failed: ${(e as Error).message}`,
        tool_call_id: toolCalls[0]?.id || "unknown",
      } as ChatCompletionMessageParam];
    }
    toolResults = sanitizeToolResults(toolResults);
    messages.push(...toolResults);

    // Track committing tools for ceiling middlewares.
    try {
      const { isCommittingTool } = await import("../committing-tool-check.js");
      for (const tc of toolCalls) {
        if (isCommittingTool(tc.name)) ctx.committingToolsThisTurn.add(tc.name);
      }
      const { markIteration } = await import("../session-turn-lock.js");
      markIteration(req.sessionId, toolCalls.map(tc => tc.name));
    } catch {}

    // ── Phase: afterToolExecution ──
    const afterToolRes = await runPhase(middlewares, "afterToolExecution", ctx, undefined, toolResults);
    if (afterToolRes.kind === "abort") return afterToolRes.turn;
    if (afterToolRes.kind === "nudge") {
      messages.push({ role: "user", content: afterToolRes.message } as ChatCompletionMessageParam);
      continue;
    }
  }

  // Max iterations reached.
  return {
    messages: [{ role: "system", content: systemPrompt }, ...messages.slice(1)],
    usage: { promptTokens: ctx.totalInput, completionTokens: ctx.totalOutput, totalTokens: ctx.totalInput + ctx.totalOutput },
    stopReason: "max_iterations",
  };
}

function abortTurn(ctx: LoopContext): AgentTurn {
  return {
    messages: ctx.messages,
    usage: {
      promptTokens: ctx.totalInput,
      completionTokens: ctx.totalOutput,
      totalTokens: ctx.totalInput + ctx.totalOutput,
    },
    stopReason: "abort",
  };
}
