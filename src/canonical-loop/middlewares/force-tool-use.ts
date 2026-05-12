/**
 * Force tool use on turn 0 for build/action intents — Codex-only.
 * Canonical-loop port of src/agent-loop/middlewares/force-tool-use.ts.
 *
 * Side-channel: writes intent to `op.canonical.toolChoice`. The canonical
 * adapter contract v1 has no `toolChoice` field on TurnInput, so adapters
 * that want to honor this read from the op state instead. Today no adapter
 * reads it — this is parity-by-shim, same posture as agent-loop's same-named
 * middleware was in until the unified loop body wired toolChoice through to
 * adapter.stream.
 */
import type { CanonicalMiddleware } from "./types.js";

const BUILD_INTENT_RE = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
const ACTION_INTENT_RE = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;

export const forceToolUseMiddleware: CanonicalMiddleware = {
  name: "force-tool-use",

  when(ctx) {
    return ctx.provider === "codex";
  },

  beforeTurn(ctx) {
    const opMut = ctx.op as typeof ctx.op & {
      canonical?: { toolChoice?: "auto" | "required" } & Record<string, unknown>;
    };
    if (!opMut.canonical) opMut.canonical = {};
    if (ctx.turnIdx === 0) {
      const msg = ctx.userMessage || "";
      if (BUILD_INTENT_RE.test(msg) || ACTION_INTENT_RE.test(msg)) {
        opMut.canonical.toolChoice = "required";
        return { kind: "continue" };
      }
    }
    opMut.canonical.toolChoice = "auto";
    return { kind: "continue" };
  },
};
