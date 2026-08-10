/**
 * Toolset chooser for delegated workers (ops spawned via op_submit /
 * op_submit_async). Pure: resolves from the live unifiedRegistry at call time
 * so the returned ToolDefinition objects are the registry's own instances and
 * their implementation fingerprints match registry state (a later chunk MACs
 * them at spawn).
 *
 * Base surface: the canonical "spawned-agent" audience resolution
 * (src/tools/audience-map.ts via resolveToolsForRequest) — availability-gated,
 * same one source of truth as agent_spawn sub-agents. This module does NOT
 * define a parallel audience system; it only SUBTRACTS from that set.
 *
 * All three lanes currently get the SAME belt: build-lane mutation support
 * (worktree provisioning so write/edit/bash can pass the security layer) is
 * descoped from this phase. When it lands, the lane parameter is the seam it
 * plugs into.
 */

import type { ToolDefinition } from "../../types.js";
import { resolveToolsForRequest, unifiedRegistry } from "../../tools/tool-search.js";
import { WORKTREE_REQUIRED_TOOLS } from "../../security/layer/types.js";
import type { OpLane } from "../types.js";

/** Lanes a delegated op can be scheduled on (OpLane minus the agent_spawn lane). */
export type DelegatedOpLane = Exclude<OpLane, "agent">;

/**
 * Tools a delegated worker must NEVER receive, regardless of what the
 * spawned-agent audience carries. Why each group:
 *
 *  - op_submit / op_submit_async / op_submit_batch / agent_spawn: no
 *    recursion-depth guard exists in this repo — a worker that can spawn
 *    workers is unbounded fan-out.
 *  - mission_schedule_* (prefix, see DENIED_TOOL_PREFIXES): scheduling stays
 *    on the interactive surfaces; an unattended worker must not install
 *    recurring jobs.
 *  - WORKTREE_REQUIRED_TOOLS (write/edit/bash + the registered synonyms,
 *    src/security/layer/types.ts): delegated workers have no worktree, so the
 *    security layer would hard-block every call. Offering tools that always
 *    fail recreates the confused-worker failure this campaign fixes.
 */
const DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "op_submit",
  "op_submit_async",
  "op_submit_batch",
  "agent_spawn",
  ...WORKTREE_REQUIRED_TOOLS,
]);

const DENIED_TOOL_PREFIXES: readonly string[] = ["mission_schedule_"];

/**
 * The one source of truth for what a delegated worker may never hold. Applied
 * both at spawn (belt subtraction below) AND at runtime augmentation
 * (chat-tool-dispatcher's tool_search path re-checks it) so tool_search can't
 * re-acquire a denied tool the belt already dropped.
 */
export function isDeniedForDelegatedWorker(name: string): boolean {
  if (DENIED_TOOL_NAMES.has(name)) return true;
  return DENIED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The tool belt for a delegated worker on the given lane. Read-only/safe
 * tools the spawned-agent audience carries (read, glob, grep, web_search,
 * web_fetch, tool_search, view_image, …) pass through; the denylist above is
 * subtracted. Only tools actually present in the registry are returned —
 * nothing is fabricated.
 */
export function delegatedToolsetForOp(lane: DelegatedOpLane): ToolDefinition[] {
  // Same belt for every lane in this phase — see the header comment. The
  // parameter is accepted now so call sites don't churn when build-lane
  // mutation support lands.
  void lane;
  const base = resolveToolsForRequest({ audience: "spawned-agent" }, unifiedRegistry.getAll());
  return base.filter((tool) => !isDeniedForDelegatedWorker(tool.name));
}
