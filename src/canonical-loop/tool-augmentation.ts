/**
 * Widening an op's tool set mid-flight.
 *
 * Look the tool up in the unified registry, add it to the dispatcher's
 * executable map, and re-register the op's tool list so the model's NEXT
 * request schema includes it. Two callers:
 *
 *  - tool_search: the model asked for a tool it could not see, and the
 *    search returned schemas as text.
 *  - a call BY NAME to a tool the schema does not carry (EXP-20, 2026-09-24):
 *    a model that knows a tool calls it whether or not the schema lists it.
 *    The 27B, with `delete_file` out of an essentials-membership schema,
 *    called it by name, was refused as "hallucinated", fell to a shell
 *    ladder and burned six rounds on a one-call task. Loading the name the
 *    way a tool_search hit is loaded costs one round less and reaches
 *    exactly the set tool_search already reaches — no new capability. The
 *    call then dispatches through every per-call gate (approval, kernel,
 *    policy, the un-named-delete card) unchanged.
 *
 * Both callers share one admission path: the delegated-worker denylist
 * applies at augmentation time, not just at spawn time — a search, or a
 * name, is not a reason to widen a worker that was deliberately restricted.
 * Neither applies the availability gate: tool_search never did (documented
 * fail-open in tools/tool-search.ts — an unconfigured tool returns its own
 * error), and by-name loading keeps parity rather than becoming a second,
 * stricter rule for the same reach.
 *
 * An earlier second caller was tried and removed (EXP-7c/7d, 2026-09-21):
 * adding a tool's COMPANION when it runs. Its "already present" check was
 * keyed on the executable map, which then held every tool, so it never
 * registered anything. Presence here is the op's schema set — `toolMap` IS
 * the schema set since the dispatcher builds it from the op's tools.
 *
 * Split out of chat-tool-dispatcher.ts, which crossed the 400-LOC gate when
 * the companion path landed.
 */
import type { ToolDefinition } from "../types.js";
import type { CallContext } from "../tool-execution/context.js";
import { unifiedRegistry } from "../tools/registry.js";
import { registerToolsForOp } from "./runtime.js";
import { isDeniedForDelegatedWorker } from "../ops/tools/delegated-toolset.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.tool-augmentation");

/** The one admission path. Returns the tools newly added to `toolMap`. */
function admit(
  names: readonly string[],
  opId: string,
  toolMap: Map<string, ToolDefinition>,
  beforeRegister: ((tools: ToolDefinition[]) => void) | undefined,
  callContext: CallContext | undefined,
  via: string,
): ToolDefinition[] {
  const discovered: ToolDefinition[] = [];
  for (const name of names) {
    if (!name || toolMap.has(name) || discovered.some((t) => t.name === name)) continue;
    // Denylist holds at AUGMENTATION time, not just spawn time: a delegated
    // worker must not search — or name — its way back to a denied tool.
    if (callContext === "delegated" && isDeniedForDelegatedWorker(name)) {
      logger.warn(`[augment] blocked denied tool '${name}' for delegated worker op=${opId.slice(0, 12)} (${via})`);
      continue;
    }
    const tool = unifiedRegistry.get(name);
    if (!tool) continue;
    discovered.push(tool);
  }
  if (discovered.length === 0) return discovered;

  const augmentedTools = [...toolMap.values(), ...discovered];
  beforeRegister?.(augmentedTools);
  for (const tool of discovered) toolMap.set(tool.name, tool);
  registerToolsForOp(opId, augmentedTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })));
  logger.info(`[augment] +${discovered.length} tool(s) for op=${opId.slice(0, 12)} (${via}): ${discovered.map((t) => t.name).join(", ")}`);
  return discovered;
}

/**
 * Parse tool_search's JSON output, look discovered tools up in the unified
 * registry, and union them into the op's executable + schema-visible tool
 * sets. Mutates `toolMap` in place and re-registers the op's tool list.
 * Idempotent — tools already present in toolMap are skipped.
 */
export function augmentFromToolSearch(
  content: string,
  opId: string,
  toolMap: Map<string, ToolDefinition>,
  beforeRegister?: (tools: ToolDefinition[]) => void,
  callContext?: CallContext,
): void {
  // tool_search returns content like:
  //   "No tools matched the query."   (skip path)
  //   "[ { name, description, parameters }, ... ]"
  if (!content.trim().startsWith("[")) return;

  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return; }
  if (!Array.isArray(parsed)) return;

  const names = parsed
    .map((entry) => (entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  admit(names, opId, toolMap, beforeRegister, callContext, "tool_search");
}

/**
 * The model called `name` and the op's schema does not carry it. Load it if
 * the registry knows it, exactly as a tool_search hit would be loaded; the
 * caller then dispatches the call normally. Returns true when the tool was
 * added — false for an unknown, denied, or already-present name, in which
 * case the call proceeds to the ordinary unknown-tool corrective.
 */
export function augmentByName(
  name: string,
  opId: string,
  toolMap: Map<string, ToolDefinition>,
  beforeRegister?: (tools: ToolDefinition[]) => void,
  callContext?: CallContext,
): boolean {
  return admit([name], opId, toolMap, beforeRegister, callContext, "by name").length > 0;
}
