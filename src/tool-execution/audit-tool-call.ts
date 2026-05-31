// Audit phase: threat-engine post-evaluation, result budgeting, PostToolUse
// hook, tool_end event, structured chip harvest, image-vs-text msg shaping.
// Always runs (preBlocked + unknown-tool paths included), since threat +
// hooks need visibility into block messages too.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { USER_HINTS, type ToolResult, type ToolChip } from "../types.js";
import { renderToolResultForModel, statusOf } from "../tools/result-helpers.js";
import { getHookEngine } from "../hooks/hook-engine.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { Phase, ToolCallContext } from "./context.js";
import { CONTINUE } from "./context.js";

interface ToolResultWithImage extends ToolResult {
  _image?: { path: string; question: string; mime: string; b64: string };
}

const RESULT_BUDGET_DIR = join(tmpdir(), "lax-results");
const DEFAULT_MAX_RESULT_SIZE = 50_000;

// Large tool results get saved to disk with a preview returned to context —
// keeps huge file reads or web fetches from blowing up the model window.
function budgetResult(content: string, maxSize: number = DEFAULT_MAX_RESULT_SIZE): string {
  if (content.length <= maxSize) return content;
  try {
    mkdirSync(RESULT_BUDGET_DIR, { recursive: true });
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const path = join(RESULT_BUDGET_DIR, `${hash}.txt`);
    writeFileSync(path, content, "utf-8");
    const preview = content.slice(0, maxSize - 200);
    const lastNewline = preview.lastIndexOf("\n");
    const cleanPreview = lastNewline > 0 ? preview.slice(0, lastNewline) : preview;
    return `${cleanPreview}\n\n... [truncated — full result (${content.length} chars) saved to ${path}]`;
  } catch {
    return content.slice(0, maxSize) + `\n\n... [truncated at ${maxSize} chars]`;
  }
}

function evaluateThreat(ctx: ToolCallContext): void {
  const { threatEngine, tc, args } = ctx;
  if (!threatEngine) return;
  const result = ctx.result!;
  const threat = threatEngine.evaluateToolResult(tc.name, args, result.content, ctx.allowed);
  if (threat.blocked) {
    // Enriched block message tells the model how the USER can grant consent
    // via /approve <description>. Without it, observed live (2026-05-13)
    // the model collapsed into "Tool call: ..." narration with no recovery
    // channel. The /approve handler lives in routes/chat/run-chat-turn.ts
    // and grants 30-min session-level consent via consent-store.ts.
    ctx.result = {
      content:
        `BLOCKED by threat engine: ${threat.reason}\n\n` +
        `If this is a legitimate workflow (user explicitly shared data with you and named the destination), ` +
        `tell the user to type:\n` +
        `  /approve <one-line description>\n` +
        `That grants 30 minutes of consent for this session. Retry the tool after they approve.\n` +
        `Do NOT retry without /approve — you will hit the same block.`,
      isError: true,
      status: "blocked",
      metadata: { layer: "threat", userHint: USER_HINTS.threatConsent },
    };
  }
  if (threatEngine.isRestricted() && ["http_request", "web_fetch", "browser"].includes(tc.name)) {
    let isOwnApp = false;
    if (tc.name === "browser") {
      const urlArg = String(args.url || "");
      const appPort = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
      if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${appPort}`, "i").test(urlArg)) {
        isOwnApp = true;
      }
    }
    if (!isOwnApp) {
      ctx.result = {
        content: `BLOCKED: Session threat level elevated. External tool calls restricted.`,
        isError: true,
        status: "blocked",
        metadata: { layer: "threat", userHint: USER_HINTS.network },
      };
    }
  }
}

function applyBudget(ctx: ToolCallContext): void {
  const result = ctx.result!;
  if (!result.isError) {
    ctx.result = { ...result, content: budgetResult(result.content) };
  }
}

function firePostHook(ctx: ToolCallContext): void {
  const { tc, args, sessionId, callContext } = ctx;
  const hookEngine = getHookEngine();
  if (!hookEngine.hasHooks || !ctx.allowed) return;
  const result = ctx.result!;
  const hookEvent = result.isError ? "PostToolUseFailure" : "PostToolUse";
  hookEngine.fireDetached({
    event: hookEvent, toolName: tc.name, toolArgs: args,
    ...(result.isError ? { toolError: result.content } : { toolResult: result.content?.slice(0, 2000) }),
    sessionId, callContext,
  });
}

function harvestChip(ctx: ToolCallContext): void {
  // Chip stays in the onEvent channel — the model's tool_result message
  // body is built from result.content only and never sees it. See ToolChip
  // docstring in src/types.ts for why op ids must NOT round-trip through
  // the model's text channel.
  const result = ctx.result!;
  const chip = (result.metadata as { chip?: ToolChip } | undefined)?.chip;
  if (chip && ctx.onEvent) {
    ctx.onEvent({ type: "tool_chip", toolCallId: ctx.tc.id, chip });
  }
}

function shapeMsg(ctx: ToolCallContext): void {
  const { tc } = ctx;
  const result = ctx.result!;
  const imageData = (result as ToolResultWithImage)._image;
  if (imageData) {
    ctx.msgs.push({ role: "tool", tool_call_id: tc.id, content: `Image loaded: ${imageData.path}\nQuestion: ${imageData.question}` } as ChatCompletionMessageParam);
    ctx.msgs.push({ role: "user", content: [
      { type: "text", text: `[Image from ${imageData.path}] ${imageData.question}` },
      { type: "image_url", image_url: { url: `data:${imageData.mime};base64,${imageData.b64}`, detail: "auto" } },
    ]} as ChatCompletionMessageParam);
  } else {
    const toolMessage = { role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) } as ChatCompletionMessageParam;
    // Video/large media rides a file PATH on the tool message — not fed to
    // the model (no image_url), just carried so the canonical dispatcher can
    // put it on the result envelope and the bridge can forward the file.
    if (result._media) (toolMessage as unknown as Record<string, unknown>)._media = result._media;
    ctx.msgs.push(toolMessage);
  }
}

export const auditPhase: Phase = async (ctx) => {
  evaluateThreat(ctx);
  applyBudget(ctx);
  firePostHook(ctx);
  ctx.onEvent?.({ type: "tool_end", toolName: ctx.tc.name, toolCallId: ctx.tc.id, result: ctx.result!.content, allowed: ctx.allowed, status: statusOf(ctx.result!) });
  harvestChip(ctx);
  shapeMsg(ctx);
  return CONTINUE;
};
