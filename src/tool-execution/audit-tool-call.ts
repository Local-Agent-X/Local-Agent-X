// Audit phase: threat-engine post-evaluation, result budgeting, PostToolUse
// hook, tool_end event, structured chip harvest, image-vs-text msg shaping.
// Always runs (preBlocked + unknown-tool paths included), since threat +
// hooks need visibility into block messages too.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { USER_HINTS, type ToolResult, type ToolChip } from "../types.js";
import { renderToolResultForModel, statusOf } from "../tools/result-helpers.js";
import { getHookEngine } from "../hooks/hook-engine.js";
import { logToolUsage } from "../tool-usage-telemetry.js";
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

// Two semantically different blocks flow through here. An exfil/sink block is a
// CONSENT problem — a human must vouch for the data flow, so the message routes
// the model to /approve. A loop block is a PROGRESS problem — the model is
// repeating itself with no consent to grant, so /approve is a dead end; it needs
// to stop and change approach. Keeping these welded (one /approve template for
// both) is what dead-ended a benign read-only grep↔read loop in the field.
export function threatBlockMessage(reason: string | undefined, loop: boolean): string {
  if (loop) {
    return (
      `STOPPED: you're repeating the same tool calls without making progress (${reason}). ` +
      `This is a loop, not a permissions problem — asking the user to approve anything will NOT ` +
      `unblock it. Stop and use what the previous results already told you, then change approach: ` +
      `a different tool, a broader or different search, or a concrete edit. If you genuinely cannot ` +
      `make progress, say so plainly and report what you found and what's left.`
    );
  }
  // Enriched block message tells the model how the USER can grant consent via
  // /approve <description>. Without it, observed live (2026-05-13) the model
  // collapsed into "Tool call: ..." narration with no recovery channel. The
  // /approve handler lives in routes/chat/run-chat-turn.ts and grants 30-min
  // session-level consent via consent-store.ts.
  return (
    `BLOCKED by threat engine: ${reason}\n\n` +
    `If this is a legitimate workflow (user explicitly shared data with you and named the destination), ` +
    `tell the user to type:\n` +
    `  /approve <one-line description>\n` +
    `That grants 30 minutes of consent for this session. Retry the tool after they approve.\n` +
    `Do NOT retry without /approve — you will hit the same block.`
  );
}

function evaluateThreat(ctx: ToolCallContext): void {
  const { threatEngine, tc, args } = ctx;
  if (!threatEngine) return;
  const result = ctx.result!;
  const threat = threatEngine.evaluateToolResult(tc.name, args, result.content, ctx.allowed);
  if (threat.blocked) {
    ctx.result = {
      content: threatBlockMessage(threat.reason, !!threat.loop),
      isError: true,
      status: "blocked",
      metadata: {
        layer: "threat",
        userHint: threat.loop ? USER_HINTS.retryExhausted : USER_HINTS.threatConsent,
      },
    };
  }
  if (threatEngine.isRestricted() && ["http_request", "web_fetch", "browser"].includes(tc.name)) {
    let isOwnApp = false;
    if (tc.name === "browser") {
      const urlArg = String(args.url || "");
      const appPort = process.env.LAX_PORT ?? "7007";
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
  const content = imageData
    ? `Image loaded: ${imageData.path}\nQuestion: ${imageData.question}`
    : renderToolResultForModel(result);
  const toolMessage = { role: "tool", tool_call_id: tc.id, content } as ChatCompletionMessageParam;
  // _media (a file PATH the bridge delivers off-box) rides the tool message in
  // ONE place, independent of _image — generate_image emits both, and branching
  // the _media carry per-image-case silently dropped its delivery. Not fed to
  // the model; just carried so the canonical dispatcher puts it on the result
  // envelope. Look tools omit _media, so they stay vision-only.
  if (result._media) (toolMessage as unknown as Record<string, unknown>)._media = result._media;
  ctx.msgs.push(toolMessage);
  // _image additionally feeds the model the bytes as a user-vision message.
  if (imageData) {
    ctx.msgs.push({ role: "user", content: [
      { type: "text", text: `[Image from ${imageData.path}] ${imageData.question}` },
      { type: "image_url", image_url: { url: `data:${imageData.mime};base64,${imageData.b64}`, detail: "auto" } },
    ]} as ChatCompletionMessageParam);
  }
}

function recordUsage(ctx: ToolCallContext): void {
  logToolUsage({
    tool: ctx.tc.name,
    action: typeof ctx.args.action === "string" ? ctx.args.action : undefined,
    status: statusOf(ctx.result!),
    durationMs: ctx.startedAt ? Date.now() - ctx.startedAt : undefined,
    sessionId: ctx.sessionId,
    callContext: ctx.callContext,
  });
}

export const auditPhase: Phase = async (ctx) => {
  evaluateThreat(ctx);
  applyBudget(ctx);
  firePostHook(ctx);
  recordUsage(ctx);
  ctx.onEvent?.({ type: "tool_end", toolName: ctx.tc.name, toolCallId: ctx.tc.id, result: ctx.result!.content, allowed: ctx.allowed, status: statusOf(ctx.result!) });
  harvestChip(ctx);
  shapeMsg(ctx);
  return CONTINUE;
};
