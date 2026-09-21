/**
 * Widening an op's tool set mid-flight.
 *
 * Two callers, one mechanism: look the tool up in the unified registry, add it
 * to the dispatcher's executable map, and re-register the op's tool list so
 * the model's NEXT request schema includes it.
 *
 *  - tool_search: the model asked for a tool it could not see.
 *  - companions: a tool's result promised a counterpart (tools/tool-companions.ts).
 *
 * Both apply the delegated-worker denylist at augmentation time, not just at
 * spawn time: neither a search nor a promise is a reason to widen a worker
 * that was deliberately restricted.
 *
 * Split out of chat-tool-dispatcher.ts, which crossed the 400-LOC gate when
 * the companion path landed.
 */
import type { ToolDefinition } from "../types.js";
import type { CallContext } from "../tool-execution/context.js";
import { unifiedRegistry } from "../tools/registry.js";
import { registerToolsForOp } from "./runtime.js";
import { isDeniedForDelegatedWorker } from "../ops/tools/delegated-toolset.js";
import { companionsFor } from "../tools/tool-companions.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.tool-augmentation");

/**
 * Parse tool_search's JSON output, look discovered tools up in the unified
 * registry, and union them into the op's executable + schema-visible tool
 * sets. Mutates `toolMap` in place and re-registers the op's tool list.
 *
 * Idempotent — tools already present in toolMap are skipped, so repeated
 * tool_search calls don't blow up the schema with duplicates.
 *
 * Delegated-worker guard: when `callContext === "delegated"`, discovered tools
 * are filtered through the SAME denylist that shapes the spawn-time belt
 * (isDeniedForDelegatedWorker — one source of truth). Without this a
 * "read-only" worker could tool_search its way back to op_submit_async,
 * mission_schedule_*, or write/edit at runtime. Non-delegated contexts
 * ("local"/"api"/"cron") are unfiltered — behavior unchanged.
 *
 * Exported for unit testing — production callers go through the dispatcher
 * closure above.
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

  const discovered: ToolDefinition[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    if (toolMap.has(name)) continue;
    // Denylist holds at AUGMENTATION time, not just spawn time: a delegated
    // worker must not tool_search its way back to a denied tool.
    if (callContext === "delegated" && isDeniedForDelegatedWorker(name)) {
      logger.warn(`[augment] blocked denied tool '${name}' for delegated worker op=${opId.slice(0, 12)}`);
      continue;
    }
    const tool = unifiedRegistry.get(name);
    if (!tool) continue;
    discovered.push(tool);
  }

  if (discovered.length === 0) return;

  const augmentedTools = [...toolMap.values(), ...discovered];
  beforeRegister?.(augmentedTools);
  for (const tool of discovered) toolMap.set(tool.name, tool);
  const augmented = augmentedTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  registerToolsForOp(opId, augmented);
  logger.info(`[augment] +${discovered.length} tool(s) for op=${opId.slice(0, 12)}: ${discovered.map(tool => tool.name).join(", ")}`);
}

/**
 * Union a tool's declared companions into the op's executable and
 * schema-visible sets, so the next turn can act on the promise the tool's
 * result just made. Same mechanism as augmentFromToolSearch — registry
 * lookup, toolMap mutation, re-register — and the same delegated-worker
 * denylist, because a promise is not a reason to widen a restricted worker.
 *
 * Idempotent: a companion already present is skipped, so repeated deletes do
 * not re-register.
 */
export function augmentCompanions(
  toolName: string,
  opId: string,
  toolMap: Map<string, ToolDefinition>,
  beforeRegister?: (tools: ToolDefinition[]) => void,
  callContext?: CallContext,
): void {
  const discovered: ToolDefinition[] = [];
  for (const name of companionsFor([toolName])) {
    if (toolMap.has(name)) continue;
    if (callContext === "delegated" && isDeniedForDelegatedWorker(name)) {
      logger.warn(`[augment] companion '${name}' denied for delegated worker op=${opId.slice(0, 12)}`);
      continue;
    }
    const tool = unifiedRegistry.get(name);
    if (!tool) continue;
    discovered.push(tool);
  }
  if (discovered.length === 0) return;

  const augmentedTools = [...toolMap.values(), ...discovered];
  beforeRegister?.(augmentedTools);
  for (const tool of discovered) toolMap.set(tool.name, tool);
  registerToolsForOp(opId, augmentedTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  })));
  logger.info(`[augment] +${discovered.length} companion(s) for '${toolName}' op=${opId.slice(0, 12)}: ${discovered.map(t => t.name).join(", ")}`);
}
