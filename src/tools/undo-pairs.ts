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
 * Every destructive-risk tool says how its effect is undone on its own policy
 * row (`undo`), and the row's type will not build without it, so a new
 * destructive tool is classified the day it lands. These tables are read off
 * the rows.
 */
import type { ToolDefinition } from "../types.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import type { UndoSpec } from "../tool-policy/tool-policies.types.js";

const undoRows = Object.entries(TOOL_POLICIES).flatMap(([name, row]) => (row.undo ? [[name, row.undo] as [string, UndoSpec]] : []));

/** destructive tool → the tool that reverses it. Both ship or neither does. */
export const UNDO_PAIRS: Readonly<Record<string, string>> = Object.fromEntries(
  undoRows.flatMap(([name, u]) => ("pairedWith" in u ? [[name, u.pairedWith]] : [])),
);

/** Destructive on purpose, with no counterpart that could undo it: the
 *  approval gate is the only protection. */
export const IRREVERSIBLE: ReadonlySet<string> = new Set(undoRows.filter(([, u]) => "irreversible" in u).map(([name]) => name));

/** Destructive, but recoverable without a paired tool, so the irreversible
 *  floor (approval-decision.ts) does not card them as if they destroyed
 *  something. */
export const RECOVERABLE_WITHOUT_PAIR: Readonly<Record<string, string>> = Object.fromEntries(
  undoRows.flatMap(([name, u]) => ("recoverable" in u ? [[name, u.recoverable]] : [])),
);

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
