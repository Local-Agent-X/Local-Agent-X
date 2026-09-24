/**
 * Undo pairing — the invariant EXP-7 did not have.
 *
 * A tool set that carries a destructive tool without the tool that undoes it
 * turns one wrong call into an unrecoverable one. EXP-7 (2026-09-21) capped the
 * tool count after the index re-rank and the 27B failed the unsafe_action gate
 * three runs out of three: the capped set kept `delete_file` and lost
 * `restore_file`. Membership may shrink (EXP-18); this table says what may
 * never be separated.
 *
 * Every destructive-risk tool (autonomy/risk.ts) is in exactly one of the two
 * lists. `undo-pairs.test.ts` fails the build when a destructive tool is in
 * neither, so a new destructive tool has to be classified the day it lands.
 */
import type { ToolDefinition } from "../types.js";

/** destructive tool → the tool that reverses it. Both ship or neither does. */
export const UNDO_PAIRS: Readonly<Record<string, string>> = {
  delete_file: "restore_file",
  process_kill: "process_start",
  process_restart: "process_start",
  autopilot_stop: "autopilot_start",
  mission_schedule_delete: "mission_schedule_create",
};

/** Destructive on purpose, with no counterpart that could undo it: the
 *  approval gate is the only protection, and it is listed here so the coverage
 *  test knows the omission is a decision, not an oversight. */
export const IRREVERSIBLE: ReadonlySet<string> = new Set([
  "app_delete",            // an app's files; the workspace mirror is the recovery path
  "op_kill",               // a running operation
  "agent_cancel",          // a spawned agent's run
  "swarm_cancel",
  "mission_delete",        // no undelete; approval-gated
  "memory_forget",         // forgetting is the point
  "memory_forget_imports",
  "forget",
  "self_edit",             // the engine's own source; git is the undo
  "email_delete",          // provider-side
  "marketplace_install",   // overwrites a custom protocol record
  "apply_update",          // the installed app; the update pipeline owns rollback
]);

/**
 * Adds each destructive tool's counterpart from the catalog when the set has
 * the destructive tool but not its pair. Order is preserved; pairs append.
 */
export function withUndoCounterparts<T extends { name: string }>(tools: T[], catalog: T[]): T[] {
  const present = new Set(tools.map((t) => t.name));
  const out = [...tools];
  for (const t of tools) {
    const pair = UNDO_PAIRS[t.name];
    if (!pair || present.has(pair)) continue;
    const counterpart = catalog.find((c) => c.name === pair);
    if (counterpart) { out.push(counterpart); present.add(pair); }
  }
  return out;
}

/** Names in `tools` that are destructive and shipped without their pair — the
 *  invariant's own check, for tests and the selection log. */
export function unpairedDestructive(tools: ReadonlyArray<ToolDefinition | { name: string }>): string[] {
  const present = new Set(tools.map((t) => t.name));
  return tools.map((t) => t.name).filter((n) => UNDO_PAIRS[n] && !present.has(UNDO_PAIRS[n]));
}
