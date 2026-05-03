/**
 * Auto-route to build_app when the model emitted a build-intent text
 * but didn't actually call build_app. Synthesizes a tool call so the
 * loop executes the build instead of letting the model "claim" it
 * built something via prose alone.
 *
 * Anthropic-only by `when` predicate — Codex + standard already get
 * tool-required forcing on iter 0 via force-tool-use; Anthropic's
 * native tool_use blocks sometimes still arrive as text only, so this
 * is the safety net for that path.
 *
 * Mutates result.toolCalls in place — the loop body builds the
 * assistant message AFTER afterModelCall fires so the synthetic call
 * lands on the pushed message naturally. No assistant-message rewrite
 * needed here.
 */

import type { LoopMiddleware } from "../types.js";
import { detectBuildIntent, extractAppName, extractBuildPrompt } from "../../providers/build-intent.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-loop.auto-build-app");

export const autoBuildAppMiddleware: LoopMiddleware = {
  name: "auto-build-app",

  when(req) {
    return req.provider === "anthropic";
  },

  afterModelCall(ctx, result) {
    if (result.toolCalls.length > 0) return { kind: "continue" };
    if (result.sawMcpActivity) return { kind: "continue" };
    const hasBuildApp = ctx.req.tools.some(t => t.name === "build_app");
    if (!hasBuildApp) return { kind: "continue" };
    if (!detectBuildIntent(result.assistantContent, ctx.req.userMessage)) return { kind: "continue" };

    const appName = extractAppName(result.assistantContent, ctx.req.userMessage);
    const buildPrompt = extractBuildPrompt(result.assistantContent, ctx.req.userMessage);
    logger.info(`auto-routing to build_app: ${appName}`);
    ctx.req.onEvent?.({ type: "stream", delta: "\n\n*Building app...*\n" });
    result.toolCalls.push({
      id: `call_${Date.now()}_build_app`,
      name: "build_app",
      arguments: JSON.stringify({ name: appName, prompt: buildPrompt }),
    });
    return { kind: "continue" };
  },
};
