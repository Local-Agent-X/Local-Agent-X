/**
 * Deliverable first: once per op, when a long request is twice past the turn
 * its goal is restated and a file the request names is still not on disk,
 * tell the model to write a version of it now and improve it in place.
 *
 * The behavior channel after two softer ones. The system prompt says to put
 * the deliverable on disk first (config/system-prompt.md, "Finish the work"),
 * and from the restate turn the per-turn digest names the files the request
 * names that are not on disk yet, as a fact (situational-awareness.ts). On
 * Terminal-Bench 2.0 (2026-11-01, qwen3.8 27B) the fact reached the model in
 * 14 of 22 and 17 of 21 requests, and it still never wrote plan_b1.jsonl or
 * gblock.txt: it ended the hour rewriting its solver for the fourth time, with
 * nothing on disk to grade. Hermes passed both tasks with a file that was
 * there. A slow local model reaches only about twenty turns in an hour, so the
 * budget ladder's first rung (25% of 160) never comes; the restate clock does.
 *
 * Named files are the request's own (`currentUserMessage`, the op's task),
 * file-shaped and resolved the way the file tools resolve them
 * (request-named-paths.ts). Inputs already exist and never count.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { goalRestateAfterTurn } from "../turn-loop/situational-awareness.js";
import { missingNamedFiles } from "../turn-loop/request-named-paths.js";
import { classifyModel, type ModelTier } from "../../model-tiers.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { resolveAgentPath } from "../../workspace/paths.js";

const KEY = "deliverable-first";

function tierOf(model: string): ModelTier | undefined {
  if (!model) return undefined;
  try { return classifyModel(model); } catch { return undefined; }
}

export function deliverableNudge(missing: readonly string[]): string {
  return [
    `SYSTEM: your request names ${missing.join(", ")}, and ${missing.length === 1 ? "it is" : "they are"} not on disk yet.`,
    `Write a working version now from what you already have, even if it is not your best yet, then keep improving the file in place.`,
    `A better answer that never reaches the file leaves the user nothing.`,
  ].join("\n");
}

export const deliverableFirstMiddleware: CanonicalMiddleware = {
  name: "deliverable-first",

  beforeTurn(ctx) {
    if (ctx.turnIdx < 2 * goalRestateAfterTurn(tierOf(ctx.model))) return { kind: "continue" };
    const state = getMiddlewareState(ctx.op.id, KEY, () => ({ fired: false }));
    if (state.fired) return { kind: "continue" };
    const sessionId = getSessionForOp(ctx.op.id);
    const missing = missingNamedFiles(ctx.currentUserMessage, (p) => resolveAgentPath(p, sessionId));
    if (missing.length === 0) return { kind: "continue" };
    state.fired = true;
    return { kind: "nudge", message: deliverableNudge(missing), reason: "deliverable-first" };
  },
};
