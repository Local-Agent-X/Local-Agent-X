/**
 * Auto-route to build_app when the model emitted a build-intent text but
 * didn't actually call build_app. Synthesizes a tool call so the loop
 * executes the build instead of letting the model "claim" it built
 * something via prose alone.
 *
 * Canonical-loop port of src/agent-loop/middlewares/auto-build-app.ts.
 * Anthropic-only via `when` predicate (AUDIT R13: standard / canonical never
 * had this; the legacy run-anthropic.ts is the only loop that did).
 *
 * Mutates ctx.toolCalls in place — turn-loop dispatches the toolCalls array
 * after afterModelCall fires, so a synthetic call appended here gets
 * executed by the canonical tool dispatcher this turn.
 */
import type { CanonicalMiddleware } from "./types.js";
import {
  detectBuildIntent,
  extractAppName,
  extractBuildPrompt,
} from "../../providers/build-intent.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.auto-build-app");

export const autoBuildAppMiddleware: CanonicalMiddleware = {
  name: "auto-build-app",

  when(ctx) {
    return ctx.provider === "anthropic";
  },

  afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (!ctx.toolNames.has("build_app")) return { kind: "continue" };
    if (!detectBuildIntent(ctx.assistantContent, ctx.userMessage)) return { kind: "continue" };

    const appName = extractAppName(ctx.assistantContent, ctx.userMessage);
    const buildPrompt = extractBuildPrompt(ctx.assistantContent, ctx.userMessage);
    logger.info(`auto-routing to build_app: ${appName}`);
    ctx.onEvent?.({ type: "stream", delta: "\n\n*Building app...*\n" });
    ctx.toolCalls.push({
      toolCallId: `call_${Date.now()}_build_app`,
      tool: "build_app",
      args: { name: appName, prompt: buildPrompt },
    });
    return { kind: "continue" };
  },
};
