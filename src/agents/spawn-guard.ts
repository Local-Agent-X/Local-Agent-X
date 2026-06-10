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

/** Tools that let a worker locate and modify existing artifacts. `edit`
 *  modifies in place; `bash`/`glob` provide the discovery a targeted edit
 *  needs; `build_app` owns the whole app-artifact lifecycle. `write` alone
 *  does NOT qualify — a writer that can't find the artifact is exactly the
 *  goal-substitution failure this guard exists to stop. */
export const EDIT_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  "edit", "bash", "glob", "build_app",
]);

const EDIT_INTENT =
  /\b(add|insert|update|edit|modify|append|integrate|remove|delete|fix|change)\b[^.!?\n]{0,60}\b(my|the|our|this|that|existing)\b[^.!?\n]{0,40}\b(app|apps|dashboard|site|website|page|file|files|project|collection|tracker|database|spreadsheet|doc|document|code|repo)\b/i;

/** True when the task text asks to modify an existing user artifact. */
export function taskNeedsArtifactEdit(task: string): boolean {
  return EDIT_INTENT.test(task);
}

/** True when the toolset can locate + modify existing artifacts. */
export function canEditArtifacts(allowedTools: readonly string[]): boolean {
  return allowedTools.some((t) => EDIT_CAPABLE_TOOLS.has(t));
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
