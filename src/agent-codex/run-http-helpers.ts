import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { AgentTurn, ServerEvent } from "../types.js";
import { streamCodexResponse, type ReasoningItem } from "../codex-client.js";
import { detectUnresolvedErrors, buildReflectionPrompt, checkApprovalHallucination, checkCreationHallucination, checkUnmatchedActionClaim } from "../agent-guards.js";
import type { ImageAttachment } from "./shared.js";
import { logRetry } from "../retry-telemetry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agent-codex.run-http-helpers");

export type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export async function buildUserContent(
  userMessage: string,
  images: ImageAttachment[] | undefined,
): Promise<string | VisionContentPart[]> {
  if (!images || images.length === 0) return userMessage;
  const parts: VisionContentPart[] = [{ type: "text", text: userMessage }];
  const filePathHints: string[] = [];
  for (const img of images) {
    try {
      const { readFileSync } = await import("node:fs");
      const data = readFileSync(img.filePath || "");
      const ext = (img.name.split(".").pop() || "png").toLowerCase();
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}`, detail: "auto" } });
      if (img.filePath) filePathHints.push(`  - ${img.name} → ${img.filePath}`);
    } catch (e) { logger.warn(`[agent] Could not read image ${img.name}:`, e); }
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
  return parts;
}

export interface CeilingState {
  totalInput: number;
  totalOutput: number;
  systemPrompt: string;
  messages: ChatCompletionMessageParam[];
  sessionId: string | undefined;
  model: string;
}

export const TURN_TOKEN_CEILING = 500_000;
export const TURN_WALL_CLOCK_MS = 180_000; // 3 min
export const MID_TURN_MIN_ITERATION = 5;
export const MID_TURN_EVIDENCE_STALE_WINDOW = 3;

export function checkTokenCeiling(state: CeilingState): AgentTurn | null {
  const { totalInput, totalOutput, systemPrompt, messages, sessionId, model } = state;
  if (totalInput + totalOutput > TURN_TOKEN_CEILING) {
    const abortMsg = `Turn token ceiling hit: ${totalInput + totalOutput} tokens used (cap ${TURN_TOKEN_CEILING}). Aborting to prevent runaway cost.`;
    logger.warn(`[agent] ${abortMsg}`);
    logRetry({ kind: "custom", sessionId, provider: "codex", model, detail: { reason: "turn-token-ceiling", totalInput, totalOutput } });
    return {
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
      stopReason: "error",
      errorMessage: abortMsg,
    };
  }
  return null;
}

export function checkWallClockCeiling(
  state: CeilingState,
  turnStartMs: number,
  iteration: number,
  committingToolsThisTurn: Set<string>,
  toolsCalledThisTurn: Set<string>,
): AgentTurn | null {
  const { totalInput, totalOutput, systemPrompt, messages, sessionId, model } = state;
  const turnElapsed = Date.now() - turnStartMs;
  if (turnElapsed > TURN_WALL_CLOCK_MS && committingToolsThisTurn.size === 0) {
    const abortMsg = `Wall-clock turn ceiling hit: ${Math.round(turnElapsed / 1000)}s elapsed on iteration ${iteration} with no committing tool call. Aborting stuck exploration.`;
    logger.warn(`[agent] ${abortMsg}`);
    logRetry({ kind: "custom", sessionId, provider: "codex", model, detail: { reason: "turn-wall-clock", elapsedMs: turnElapsed, iteration, tools: Array.from(toolsCalledThisTurn) } });
    return {
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
      stopReason: "error",
      errorMessage: abortMsg,
    };
  }
  return null;
}

export function checkMidTurnStale(
  state: CeilingState,
  iteration: number,
  evidenceHistory: number[],
  committingToolsThisTurn: Set<string>,
): AgentTurn | null {
  const { totalInput, totalOutput, systemPrompt, messages, sessionId, model } = state;
  if (iteration >= MID_TURN_MIN_ITERATION && evidenceHistory.length >= MID_TURN_EVIDENCE_STALE_WINDOW && committingToolsThisTurn.size === 0) {
    const window = evidenceHistory.slice(-MID_TURN_EVIDENCE_STALE_WINDOW);
    const allEqual = window.every(v => v === window[0]);
    if (allEqual) {
      const abortMsg = `Mid-turn evidence stale: evidence count ${window[0]} for ${MID_TURN_EVIDENCE_STALE_WINDOW} iterations with no committing tool. Aborting stuck exploration.`;
      logger.warn(`[agent] ${abortMsg}`);
      logRetry({ kind: "custom", sessionId, provider: "codex", model, detail: { reason: "mid-turn-stale", iteration, evidence: window } });
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
        errorMessage: abortMsg,
      };
    }
  }
  return null;
}

export async function drainSubagentCompletions(
  messages: ChatCompletionMessageParam[],
  sessionId: string | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const { drainCompletions, formatCompletionMessage } = await import("../agency/completion-queue.js");
    const notices = drainCompletions(sessionId);
    if (notices.length > 0) {
      messages.push({ role: "user", content: formatCompletionMessage(notices) } as ChatCompletionMessageParam);
      return true;
    }
  } catch {}
  return false;
}

export interface EmptyResponseInput {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatCompletionMessageParam[];
  codexTools: NonNullable<Parameters<typeof streamCodexResponse>[0]["tools"]>;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  assistantContent: string;
  turnReasoning: ReasoningItem[];
  totalInput: number;
  totalOutput: number;
  iteration: number;
  contentFilterEmpties: number;
  onEvent?: (event: ServerEvent) => void;
}

export interface EmptyResponseResult {
  assistantContent: string;
  turnReasoning: ReasoningItem[];
  totalInput: number;
  totalOutput: number;
  previousResponseId: string | undefined;
  contentFilterEmpties: number;
  abortTurn?: AgentTurn;
  injectedNudge: boolean;
}

export async function handleEmptyResponse(input: EmptyResponseInput): Promise<EmptyResponseResult> {
  const { apiKey, model, systemPrompt, messages, codexTools, toolCalls, onEvent } = input;
  let { assistantContent, turnReasoning, totalInput, totalOutput, contentFilterEmpties } = input;

  logger.warn(`[agent] Codex returned empty response (iteration ${input.iteration}, ${totalInput}in/${totalOutput}out tokens) — retrying`);
  // Retry without previousResponseId to force full context
  let previousResponseId: string | undefined = undefined;
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
    logger.error(`[agent] Codex retry failed:`, (e as Error).message);
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
      logger.warn("[agent] Codex content-filter nudge (1st attempt — asking for neutral summary)");
      messages.push({ role: "user", content: nudge } as ChatCompletionMessageParam);
      return {
        assistantContent,
        turnReasoning,
        totalInput,
        totalOutput,
        previousResponseId: undefined,
        contentFilterEmpties,
        injectedNudge: true,
      };
    }
    const msg = `content_filter: Codex returned ${contentFilterEmpties} empty responses this turn — moderation loop. Aborting so another provider can take the turn.`;
    logger.warn(`[agent] ${msg}`);
    return {
      assistantContent,
      turnReasoning,
      totalInput,
      totalOutput,
      previousResponseId: undefined,
      contentFilterEmpties,
      injectedNudge: false,
      abortTurn: {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
        errorMessage: msg,
      },
    };
  }

  return {
    assistantContent,
    turnReasoning,
    totalInput,
    totalOutput,
    previousResponseId,
    contentFilterEmpties,
    injectedNudge: false,
  };
}

export interface NoToolCallInput {
  assistantContent: string;
  messages: ChatCompletionMessageParam[];
  iteration: number;
  maxIterations: number;
  toolsCalledThisTurn: Set<string>;
  unmatchedClaimNudged: boolean;
  selfCheckFired: boolean;
}

export interface NoToolCallResult {
  shouldContinue: boolean;
  unmatchedClaimNudged: boolean;
  selfCheckFired: boolean;
}

export function handleNoToolCallBranch(input: NoToolCallInput): NoToolCallResult {
  const { assistantContent, messages, iteration, maxIterations, toolsCalledThisTurn } = input;
  let { unmatchedClaimNudged, selfCheckFired } = input;

  // Approval hallucination: model says "needs approval" instead of calling tool
  const approvalNudge = checkApprovalHallucination(assistantContent);
  if (approvalNudge && iteration < maxIterations - 1) {
    logger.warn(`[agent] Approval hallucination detected (Codex) — nudging`);
    messages.push({ role: "user", content: approvalNudge } as ChatCompletionMessageParam);
    return { shouldContinue: true, unmatchedClaimNudged, selfCheckFired };
  }

  // Creation hallucination: model claims it created/scheduled something without a tool call
  const creationNudge = checkCreationHallucination(assistantContent);
  if (creationNudge && iteration === 0) {
    logger.warn(`[agent] Creation hallucination detected (Codex) — nudging`);
    messages.push({ role: "user", content: creationNudge } as ChatCompletionMessageParam);
    return { shouldContinue: true, unmatchedClaimNudged, selfCheckFired };
  }

  // Tool-verified action-claim check: if the reply claims an action
  // verb whose matching tools were never called THIS TURN, nudge once.
  if (!unmatchedClaimNudged && iteration < maxIterations - 1) {
    const claimNudge = checkUnmatchedActionClaim(assistantContent, toolsCalledThisTurn);
    if (claimNudge) {
      logger.warn(`[agent] Unmatched action claim detected (Codex) — nudging`);
      unmatchedClaimNudged = true;
      messages.push({ role: "user", content: claimNudge } as ChatCompletionMessageParam);
      return { shouldContinue: true, unmatchedClaimNudged, selfCheckFired };
    }
  }

  // Self-check: unresolved tool errors
  const unresolvedErrors = !selfCheckFired ? detectUnresolvedErrors(messages) : [];
  if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
    selfCheckFired = true;
    messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
    return { shouldContinue: true, unmatchedClaimNudged, selfCheckFired };
  }

  return { shouldContinue: false, unmatchedClaimNudged, selfCheckFired };
}
