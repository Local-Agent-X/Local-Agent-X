import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, AgentTurn, ServerEvent } from "./types.js";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { streamCodexResponse, type ReasoningItem } from "./codex-client.js";
import { executeToolCalls, checkAndCompact } from "./tool-executor.js";
import { stripEphemeralMessages } from "./agent-providers.js";
import { detectUnresolvedErrors, buildReflectionPrompt, checkApprovalHallucination, checkCreationHallucination, checkUnmatchedActionClaim, checkToolLoops, createLoopState, checkDeadEnd, createDeadEndState } from "./agent-guards.js";
import { stripSystemInjectionTags } from "./sanitize.js";

interface ImageAttachment {
  url: string;
  filePath?: string;
  name: string;
}

interface AgentOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider: "xai" | "openai" | "codex" | "anthropic" | "local" | "gemini" | "custom";
  systemPrompt: string;
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  maxIterations?: number;
  temperature?: number;
  images?: ImageAttachment[];
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  pauseCallback?: (reason: string) => Promise<string>;
}

// ── Codex (ChatGPT subscription) Agent Loop ──
//
// Codex tool calls are routed through the canonical tool-executor in
// runCodexAgentHttp(), so they get the same security, hooks, retry,
// circuit breaker, rate limiting, and tracker treatment as Anthropic/xAI.
// (The previous WebSocket path was disabled in production and bypassed
// the executor entirely — it has been removed to prevent that drift.)

export async function runCodexAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  return runCodexAgentHttp(userMessage, history, options);
}

// ── HTTP path (canonical) ──

export async function runCodexAgentHttp(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const { apiKey, model, systemPrompt, tools, security, maxIterations = 160, onEvent, signal } = options;
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  type VisionContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
  let userContent: string | VisionContentPart[] = userMessage;
  if (options.images && options.images.length > 0) {
    const parts: VisionContentPart[] = [{ type: "text", text: userMessage }];
    const filePathHints: string[] = [];
    for (const img of options.images) {
      try {
        const { readFileSync } = await import("node:fs");
        const data = readFileSync(img.filePath || "");
        const ext = (img.name.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}`, detail: "auto" } });
        if (img.filePath) filePathHints.push(`  - ${img.name} → ${img.filePath}`);
      } catch (e) { console.warn(`[agent] Could not read image ${img.name}:`, e); }
    }
    // Tell the model WHERE the actual file lives on disk. Without this, the
    // model only gets the image via vision (it can see the content) but has
    // no way to reference the bytes — so asked to "use this image as
    // background," it invents a new one instead of copying the real file.
    if (filePathHints.length > 0) {
      parts.push({
        type: "text",
        text:
          `\n\n[Attached file paths on disk — use these if you need to copy the real bytes into the workspace]\n` +
          filePathHints.join("\n") +
          `\n\nTo use an attachment as an app asset: read the file with bash/read, then write it to the target path under workspace/apps/<app>/, or use bash cp. Do NOT generate a new image or download from the web when a user attachment exists — use the file at the path above.`,
      });
    }
    userContent = parts;
  }

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
    await import("./agent-loop-detectors.js");
  const { createPromptLayers, composeSystemPrompt, isAckMessage, ACK_FAST_PATH_INSTRUCTION } =
    await import("./agent-loop-prompt-layers.js");
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
  const TURN_TOKEN_CEILING = 500_000;
  const TURN_WALL_CLOCK_MS = 180_000; // 3 min
  const MID_TURN_MIN_ITERATION = 5;
  const MID_TURN_EVIDENCE_STALE_WINDOW = 3;
  const turnStartMs = Date.now();
  const committingToolsThisTurn = new Set<string>();
  // Heartbeat ticker so the UI sees live progress instead of "Still waiting..."
  // Auto-stops when the turn-lock releases (tied to the chat route's finally).
  const { startHeartbeat } = await import("./session-heartbeat.js");
  const heartbeat = startHeartbeat({ sessionId: options.sessionId, onEvent, turnStartMs });
  const { onTurnRelease } = await import("./session-turn-lock.js");
  onTurnRelease(options.sessionId, () => heartbeat.stop());

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };

    if (totalInput + totalOutput > TURN_TOKEN_CEILING) {
      const abortMsg = `Turn token ceiling hit: ${totalInput + totalOutput} tokens used (cap ${TURN_TOKEN_CEILING}). Aborting to prevent runaway cost.`;
      console.warn(`[agent] ${abortMsg}`);
      try { import("./retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "codex", model, detail: { reason: "turn-token-ceiling", totalInput, totalOutput } })).catch(() => {}); } catch {}
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
        errorMessage: abortMsg,
      };
    }

    // Wall-clock ceiling — safety net for turns that don't burn tokens fast
    // but grind on tool calls without ever committing. Only fires when no
    // committing tool has been called this turn.
    const turnElapsed = Date.now() - turnStartMs;
    if (turnElapsed > TURN_WALL_CLOCK_MS && committingToolsThisTurn.size === 0) {
      const abortMsg = `Wall-clock turn ceiling hit: ${Math.round(turnElapsed / 1000)}s elapsed on iteration ${iteration} with no committing tool call. Aborting stuck exploration.`;
      console.warn(`[agent] ${abortMsg}`);
      try { import("./retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "codex", model, detail: { reason: "turn-wall-clock", elapsedMs: turnElapsed, iteration, tools: Array.from(toolsCalledThisTurn) } })).catch(() => {}); } catch {}
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
        errorMessage: abortMsg,
      };
    }

    // Mid-turn evidence-staleness: after MID_TURN_MIN_ITERATION, check the
    // last MID_TURN_EVIDENCE_STALE_WINDOW evidence counts. If flat and no
    // committing tool has been called, abort — the agent is spinning without
    // progress. Differs from the post-turn staleness check which only runs
    // at exit; this one catches stuck-in-middle cases too.
    if (iteration >= MID_TURN_MIN_ITERATION && evidenceHistory.length >= MID_TURN_EVIDENCE_STALE_WINDOW && committingToolsThisTurn.size === 0) {
      const window = evidenceHistory.slice(-MID_TURN_EVIDENCE_STALE_WINDOW);
      const allEqual = window.every(v => v === window[0]);
      if (allEqual) {
        const abortMsg = `Mid-turn evidence stale: evidence count ${window[0]} for ${MID_TURN_EVIDENCE_STALE_WINDOW} iterations with no committing tool. Aborting stuck exploration.`;
        console.warn(`[agent] ${abortMsg}`);
        try { import("./retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "codex", model, detail: { reason: "mid-turn-stale", iteration, evidence: window } })).catch(() => {}); } catch {}
        return {
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
          stopReason: "error",
          errorMessage: abortMsg,
        };
      }
    }

    if (iteration > 0) messages = stripEphemeralMessages(messages);
    messages = checkAndCompact(messages, model, onEvent);

    // Drain subagent completion queue — push-based signaling so the parent
    // doesn't burn iterations polling agent_status.
    if (options.sessionId) {
      try {
        const { drainCompletions, formatCompletionMessage } = await import("./agency/completion-queue.js");
        const notices = drainCompletions(options.sessionId);
        if (notices.length > 0) {
          messages.push({ role: "user", content: formatCompletionMessage(notices) } as ChatCompletionMessageParam);
          // Invalidate previousResponseId so Codex sees the newly-pushed message
          previousResponseId = undefined;
          lastContextLength = 0;
        }
      } catch {}
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
      const { isContextOverflowError, forceCompact } = await import("./context-manager.js");
      if (isContextOverflowError(e) && iteration < maxIterations - 1) {
        const before = messages.length;
        messages = forceCompact(messages, 2);
        previousResponseId = undefined; // Force full-context restart next turn
        lastContextLength = 0;
        console.warn(`[agent] Codex context overflow — force-compacted ${before} → ${messages.length} msgs and retrying`);
        try { import("./retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "context-overflow", sessionId: options.sessionId, detail: { provider: "codex", model, before, after: messages.length } })).catch(() => {}); } catch {}
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
        try { import("./retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "codex", model, detail: { reason: "no-tool-output-recovery", iteration } })).catch(() => {}); } catch {}
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
      console.warn(`[agent] Codex returned empty response (iteration ${iteration}, ${totalInput}in/${totalOutput}out tokens) — retrying`);
      // Retry without previousResponseId to force full context
      previousResponseId = undefined;
      try {
        let retryText = "";
        const retryStream = streamCodexResponse({ token: apiKey, model, messages, systemPrompt, tools: codexTools });
        for await (const event of retryStream) {
          if (event.type === "text") { retryText += event.delta; onEvent?.({ type: "stream", delta: event.delta }); }
          else if (event.type === "tool_call") { toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments }); }
          else if (event.type === "reasoning") { turnReasoning.push(event.item); }
          else if (event.type === "done") {
            totalInput += event.usage.inputTokens;
            totalOutput += event.usage.outputTokens;
            if (event.responseId) previousResponseId = event.responseId;
            if (event.reasoning.length > 0 && turnReasoning.length === 0) turnReasoning = event.reasoning;
          }
        }
        if (retryText.trim()) assistantContent = retryText;
      } catch (e) {
        console.error(`[agent] Codex retry failed:`, (e as Error).message);
      }

      // Content-filter escape valve. When Codex moderation trips on context
      // (e.g. personal/emotional email content post-send), every future
      // response comes back empty.
      //
      // Two-stage recovery:
      //   1. First trip: inject a nudge telling the model to reply with a
      //      short neutral summary — often enough to snap Codex out of the
      //      moderation loop WITHOUT failing over to another provider.
      //   2. Second trip: bail with a typed error so the chat route's
      //      provider failover (→ Claude, xAI, etc.) takes over.
      // Prevents the 18-retry / $0.80 spinout observed in the jennycortez
      // smtp-setup incident where Codex burned ~2 minutes on the confirmation
      // message after a successful send.
      if (toolCalls.length === 0 && !assistantContent.trim()) {
        contentFilterEmpties++;
        if (contentFilterEmpties === 1) {
          const nudge =
            "[SYSTEM] Your previous reply came back empty — content moderation likely blocked it. Reply with ONE short neutral sentence confirming what was done. Do NOT quote email bodies, personal/emotional content, passwords, or any sensitive details. Just: `[action] completed.`";
          console.warn("[agent] Codex content-filter nudge (1st attempt — asking for neutral summary)");
          messages.push({ role: "user", content: nudge } as ChatCompletionMessageParam);
          previousResponseId = undefined;
          lastContextLength = 0;
          continue;
        }
        const msg = `content_filter: Codex returned ${contentFilterEmpties} empty responses this turn — moderation loop. Aborting so another provider can take the turn.`;
        console.warn(`[agent] ${msg}`);
        previousResponseId = undefined;
        return {
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
          stopReason: "error",
          errorMessage: msg,
        };
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
        try { import("./retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "codex", model, detail: { reason: `post-turn-${hit.kind}` } })).catch(() => {}); } catch {}
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
      // Approval hallucination: model says "needs approval" instead of calling tool
      const approvalNudge = checkApprovalHallucination(assistantContent);
      if (approvalNudge && iteration < maxIterations - 1) {
        console.warn(`[agent] Approval hallucination detected (Codex) — nudging`);
        messages.push({ role: "user", content: approvalNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Creation hallucination: model claims it created/scheduled something without a tool call
      const creationNudge = checkCreationHallucination(assistantContent);
      if (creationNudge && iteration === 0) {
        console.warn(`[agent] Creation hallucination detected (Codex) — nudging`);
        messages.push({ role: "user", content: creationNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Tool-verified action-claim check: if the reply claims an action
      // verb whose matching tools were never called THIS TURN, nudge once.
      if (!unmatchedClaimNudged && iteration < maxIterations - 1) {
        const claimNudge = checkUnmatchedActionClaim(assistantContent, toolsCalledThisTurn);
        if (claimNudge) {
          console.warn(`[agent] Unmatched action claim detected (Codex) — nudging`);
          unmatchedClaimNudged = true;
          messages.push({ role: "user", content: claimNudge } as ChatCompletionMessageParam);
          continue;
        }
      }

      // Self-check: unresolved tool errors
      const unresolvedErrors = !selfCheckFired ? detectUnresolvedErrors(messages) : [];
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
        selfCheckFired = true;
        messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
        continue;
      }

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
    const { isCommittingTool: isCommitting } = await import("./committing-tool-check.js");
    const { markIteration: markTurnLockIteration } = await import("./session-turn-lock.js");
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
