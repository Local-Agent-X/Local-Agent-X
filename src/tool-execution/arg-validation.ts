// Tool lookup + argument validation phases (split from enforce-policy.ts for
// the source-hygiene LOC ceiling). Owns the structured correctives a weak
// model needs to self-correct in one turn: the exact available tool names for
// a hallucinated tool, the specific failing field for malformed args.

import { logRetry } from "../retry-telemetry.js";
import type { ToolResult } from "../types.js";
import type { PhaseOutcome, ToolCallContext } from "./context.js";
import { terminate, CONTINUE, BLOCK } from "./context.js";

// Cap on how many tool names a corrective lists inline. The op's surface is
// already tier-capped upstream (shrinkToolsForTier), so weak models naturally
// get a short list and strong models a longer one; this only guards the extreme.
const AVAILABLE_TOOLS_CAP = 50;

/**
 * Structured corrective for a hallucinated / mistyped tool name. A bare
 * "Unknown tool: X" leaves a weak model guessing — listing the exact names it
 * CAN call lets it self-correct in one turn instead of re-hallucinating. The
 * available set is the op's own (already-tier-capped) surface, so the message
 * self-scales to the model's tier. Pure + exported for unit testing.
 */
export function formatUnknownToolCorrection(toolName: string, available: string[]): string {
  const names = [...available].sort();
  const head = `Unknown tool "${toolName}" — not one of your available tools. `;
  const tail = "If you need a capability that isn't listed, call tool_search to load it.";
  if (names.length === 0) return head + tail;
  const list = names.length <= AVAILABLE_TOOLS_CAP
    ? names.join(", ")
    : names.slice(0, AVAILABLE_TOOLS_CAP).join(", ") + `, …(+${names.length - AVAILABLE_TOOLS_CAP} more)`;
  return head + `Use one of these exact names: ${list}. ` + tail;
}

export function lookupTool(ctx: ToolCallContext): PhaseOutcome {
  const tool = ctx.toolMap.get(ctx.tc.name);
  if (!tool) {
    ctx.allowed = false;
    ctx.result = {
      content: formatUnknownToolCorrection(ctx.tc.name, [...ctx.toolMap.keys()]),
      isError: true,
      status: "error",
      metadata: { recovery: "Tool name typo or hallucinated name. Use one of the listed tool names exactly, or tool_search to load a capability that isn't listed." },
    };
    return BLOCK;
  }
  ctx.tool = tool;
  return CONTINUE;
}

/**
 * Collect per-field schema violations (required[], top-level type, enum) for a
 * tool call's args. Pure + exported so the structured-corrective contract — the
 * specific failing field, not a bare "invalid arguments" — is unit-testable.
 */
export function collectArgViolations(
  args: Record<string, unknown>,
  schema: { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined,
): string[] {
  const errs: string[] = [];
  if (!schema?.properties) return errs;
  for (const req of schema.required || []) {
    if (!(req in args)) errs.push(`missing required field "${req}"`);
  }
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in args)) continue;
    const val = args[key];
    if (propSchema.type === "string" && typeof val !== "string") errs.push(`"${key}" must be a string (got ${typeof val})`);
    else if (propSchema.type === "number" && typeof val !== "number") errs.push(`"${key}" must be a number (got ${typeof val})`);
    else if (propSchema.type === "boolean" && typeof val !== "boolean") errs.push(`"${key}" must be a boolean (got ${typeof val})`);
    else if (propSchema.type === "array" && !Array.isArray(val)) errs.push(`"${key}" must be an array (got ${typeof val})`);
    if (propSchema.enum && !propSchema.enum.includes(val)) errs.push(`"${key}" must be one of [${propSchema.enum.map(v => JSON.stringify(v)).join(", ")}] (got ${JSON.stringify(val)})`);
  }
  return errs;
}

// Weak models emit malformed args. Lightweight required[] + type checks on
// top-level fields; safe scalar coercion ("5" → 5) before validation.
export async function validateArgs(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, tool, sessionId } = ctx;
  if (!tool) return CONTINUE;
  const schema = tool.parameters as { type?: string; properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined;

  if (schema && typeof ctx.args === "object" && ctx.args && !("_raw" in ctx.args)) {
    try {
      const { coerceArgs } = await import("./arg-repair.js");
      const coerce = coerceArgs(ctx.args as Record<string, unknown>, schema);
      if (coerce.fixes.length > 0) {
        ctx.args = coerce.coerced;
        logRetry({ kind: "tool-arg-invalid", sessionId, tool: tc.name, detail: { phase: "coerce", fixes: coerce.fixes } });
      }
    } catch {}
  }

  const errs = collectArgViolations(ctx.args as Record<string, unknown>, schema);
  if (errs.length === 0) return CONTINUE;

  const result: ToolResult = {
    content: `Invalid arguments for ${tc.name}: ${errs.join("; ")}. Fix and retry.`,
    isError: true,
    status: "error",
    metadata: { recovery: "Schema validation failed — fix the listed fields and retry. This is NOT a policy denial; the tool itself is available." },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}
