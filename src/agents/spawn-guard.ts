/**
 * Spawn-time capability guard — delegation ROUTER correctness, not an
 * anti-delegation gate.
 *
 * Catches the one objectively wrong delegation: a task that asks to modify
 * an EXISTING user artifact ("add it to my dashboard", "fix the bug in my
 * app") handed to a role whose toolset can neither locate nor edit one.
 * Such a worker structurally cannot finish; the observed failure mode
 * (twice, 2026-06-09) is goal substitution — it writes a NEW file somewhere
 * else and reports success.
 *
 * Always-delegate modes (voice chat, the planned delegate-everything
 * toggle) make this guard MORE important, not less: when every task is
 * handed off, picking a capable worker is the whole game. The error
 * therefore never says "do it yourself instead" as the only path — it names
 * capable agents so the caller re-routes or splits the task.
 *
 * Conservative on purpose: creating NEW artifacts is fine for any role with
 * write, and pure research/summary tasks never match the intent pattern.
 * False negatives are acceptable; false positives would fight legitimate
 * delegation.
 */

import { policyRowOf, TOOL_PATH_ARGS } from "../tool-registry.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import type { CallContext } from "../tool-execution/context.js";
import { shellAllowedInContext } from "../tool-execution/unattended-shell-gate.js";

/** Tools that let a worker locate and modify existing artifacts in any run,
 *  read off their rows: an edit of a declared path (an `edit` path spec, or a
 *  family's `edit` action) modifies in place and fails on a file that is not
 *  there; a search root (glob, grep) is the discovery a targeted edit needs;
 *  `build_app` owns the whole app-artifact lifecycle. A plain `write` does NOT
 *  qualify — a writer that can't find the artifact is exactly the
 *  goal-substitution failure this guard exists to stop. */
function editCapable(name: string): boolean {
  const specs = TOOL_PATH_ARGS[name] ?? [];
  return specs.some((s) => s.action === "edit" || s.forActions?.includes("edit") || s.searchRoot === true)
    || name === "build_app";
}

export const EDIT_CAPABLE_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_POLICIES).filter(editCapable));

/** A model-authored shell command locates and modifies too — in a run that may
 *  use the shell. An unattended run without a confined sandbox parks every
 *  shell call for a person (tool-execution/unattended-shell-gate.ts), so a role
 *  whose only edit path is the shell would stall there, not edit. */
function shellEditCapable(name: string): boolean {
  return policyRowOf(name)?.shellCommand !== undefined;
}

const EDIT_INTENT =
  /\b(add|insert|update|edit|modify|append|integrate|remove|delete|fix|change)\b[^.!?\n]{0,60}\b(my|the|our|this|that|existing)\b[^.!?\n]{0,40}\b(app|apps|dashboard|site|website|page|file|files|project|collection|tracker|database|spreadsheet|doc|document|code|repo)\b/i;

/** True when the task text asks to modify an existing user artifact. */
export function taskNeedsArtifactEdit(task: string): boolean {
  return EDIT_INTENT.test(task);
}

/** True when the toolset can locate + modify existing artifacts in a run of
 *  `runContext` — the context the spawn is about to create, so the shell term
 *  is judged by the gate that run's shell calls will meet. */
export function canEditArtifacts(allowedTools: readonly string[], runContext: CallContext): boolean {
  return allowedTools.some((t) => EDIT_CAPABLE_TOOLS.has(t))
    || (shellAllowedInContext(runContext) && allowedTools.some(shellEditCapable));
}

/** Actionable rejection for a capability-mismatched spawn. Lists capable
 *  agents from the caller's roster so re-routing is one tool call away. */
export function spawnMismatchMessage(
  role: string,
  allowedTools: readonly string[],
  capableAgents: readonly { name: string; role: string; id: string }[],
): string {
  const roster = capableAgents
    .slice(0, 5)
    .map((a) => `${a.name} ("${a.role}", id: ${a.id})`)
    .join("; ");
  return (
    `Spawn rejected: the task asks to modify an existing app/file, but "${role}" ` +
    `cannot locate or edit one (tools: ${allowedTools.join(", ")}). It would fake ` +
    `completion by writing a new file somewhere else. Delegation is the right ` +
    `instinct — route it to a capable agent instead` +
    (roster ? `: ${roster}. ` : ` (none on this roster — use agent_create). `) +
    `Or split the task: spawn "${role}" for the research half, then a capable ` +
    `agent for the edit half (include the exact file path in its task).`
  );
}
