import type { ToolDefinition } from "../types.js";
import { collapseFamily } from "../tools/shared/collapse-family.js";
import { createCoreProtocolTools } from "./index.js";

/**
 * The single model-facing `protocol` tool — the protocol_* family collapsed
 * to one schema. Every former protocol_<action> tool keeps its implementation
 * (createCoreProtocolTools is untouched); this wrapper exposes them as
 * `protocol(action, params)` so the family costs one schema per turn, not 34.
 *
 * Destructive actions (delete, prune, archive_bulk, rollback_undo, var_delete)
 * stay approval-gated via the action-aware table in approval-decision.ts —
 * keep that table in sync when adding a destructive action here.
 *
 * Marketplace tools (marketplace_*) are a separate deferred family and pass
 * through uncollapsed.
 */
export function createProtocolFamilyTools(): ToolDefinition[] {
  const inner = createCoreProtocolTools();
  const actions: Record<string, ToolDefinition> = {};
  const passthrough: ToolDefinition[] = [];
  for (const tool of inner) {
    if (tool.name.startsWith("protocol_")) {
      actions[tool.name.slice("protocol_".length)] = tool;
    } else {
      passthrough.push(tool);
    }
  }

  const protocolTool = collapseFamily({
    name: "protocol",
    intro:
      "Work with protocols — pre-built multi-step workflows the agent knows (list them, load one " +
      "before executing a workflow, create/edit custom ones, manage variables, chains, progress, " +
      "rollback, and curation). Call protocol(action:\"get\", params:{name}) BEFORE executing a " +
      "multi-step workflow like posting to Instagram — the rules contain critical lessons. " +
      "Start with action:\"list\" when the user asks what you can do.",
    actions,
  });

  return [protocolTool, ...passthrough];
}
