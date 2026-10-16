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
 * define a parallel audience system; it only SUBTRACTS from that set, and on
 * the build lane ADDS the mutation belt.
 *
 * Lanes: interactive and background workers are read-only. A build worker is
 * submitted with a work root (ops/tools/work-root.ts) and gets the write
 * family plus bash on top; confinement is the security layer's existing
 * delegated gate (security/layer/delegated-worktree-gate.ts): the work root
 * is its isolation, the sandbox its containment — this module grants no
 * authority of its own.
 */

import type { ToolDefinition } from "../../types.js";
import { resolveToolsForRequest, unifiedRegistry } from "../../tools/tool-search.js";
import { WORKTREE_REQUIRED_TOOLS } from "../../security/layer/types.js";
import type { OpLane } from "../types.js";

/** Lanes a delegated op can be scheduled on (OpLane minus the agent_spawn lane). */
export type DelegatedOpLane = Exclude<OpLane, "agent">;

/** What decides a delegated worker's belt: its lane, and on the build lane
 *  the work root its mutations are confined to. */
export interface DelegatedBelt {
  lane: DelegatedOpLane;
  workRoot?: string;
}

/** The mutation belt a build worker gets on top of the read/search base
 *  (decision D5): the write family and bash. Every member is in
 *  WORKTREE_REQUIRED_TOOLS, so each call still passes the delegated gate.
 *  The other worktree-required spellings (ari_file, process_start,
 *  bulk_replace) stay denied on every lane. */
export const BUILD_MUTATION_TOOLS: readonly string[] = [
  "write", "edit", "multi_edit", "edit_lines", "delete_file", "restore_file", "bash",
];

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
 *    src/security/layer/types.ts): a read-only worker has no worktree, so the
 *    security layer would hard-block every call. Offering tools that always
 *    fail recreates the confused-worker failure this campaign fixed. A build
 *    worker with a work root takes BUILD_MUTATION_TOOLS back out of this set.
 */
const DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "op_submit",
  "op_submit_async",
  "op_submit_batch",
  "agent_spawn",
  ...WORKTREE_REQUIRED_TOOLS,
]);

const DENIED_TOOL_PREFIXES: readonly string[] = ["mission_schedule_"];

/** A build worker mutates only when it was submitted with a work root. */
export function delegatedWorkerMayMutate(belt: DelegatedBelt): boolean {
  return belt.lane === "build" && !!belt.workRoot;
}

/**
 * The one source of truth for what a delegated worker may never hold. Applied
 * both at spawn (belt subtraction below) AND at runtime augmentation
 * (canonical-loop/tool-augmentation.ts re-checks it) so tool_search can't
 * re-acquire a denied tool the belt already dropped. Without a belt the
 * answer is the read-only lane's.
 */
export function isDeniedForDelegatedWorker(name: string, belt?: DelegatedBelt): boolean {
  if (belt && delegatedWorkerMayMutate(belt) && BUILD_MUTATION_TOOLS.includes(name)) return false;
  if (DENIED_TOOL_NAMES.has(name)) return true;
  return DENIED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The tool belt for a delegated worker. Read-only/safe tools the
 * spawned-agent audience carries (read, glob, grep, web_search, web_fetch,
 * tool_search, view_image, …) pass through; the denylist above is subtracted.
 * A build worker with a work root also gets BUILD_MUTATION_TOOLS, pulled from
 * the registry by name because delete_file/restore_file carry a main-chat
 * audience. Only tools actually present in the registry are returned —
 * nothing is fabricated.
 */
export function delegatedToolsetForOp(lane: DelegatedOpLane, opts: { workRoot?: string } = {}): ToolDefinition[] {
  const belt: DelegatedBelt = { lane, workRoot: opts.workRoot };
  const base = resolveToolsForRequest({ audience: "spawned-agent" }, unifiedRegistry.getAll())
    .filter((tool) => !isDeniedForDelegatedWorker(tool.name, belt));
  if (!delegatedWorkerMayMutate(belt)) return base;
  const present = new Set(base.map((tool) => tool.name));
  const mutation = BUILD_MUTATION_TOOLS
    .filter((name) => !present.has(name))
    .map((name) => unifiedRegistry.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
  return [...base, ...mutation];
}
