/**
 * review_changes — the agent's look at everything it changed for the current
 * request, before it says it's done: each file with its diff against what the file
 * held before the request (one view, so a stray edit, a debug line or a file it
 * forgot it touched shows up). The user's "Edited N files" card, for the agent.
 *
 * Built on the rollback store, which already keeps each changed file's bytes from
 * before every write (autonomy/rollback.ts): changesSinceOp gives the earliest
 * capture of each file this request changed, and fileChangeOf makes the same diff
 * the chat's card shows. What it cannot see, it says: a shell command's changes to
 * files its text does not name are not captured. Read-only; every path passes the
 * file-access read gate here, since the paths come from the store, not the call.
 */
import { existsSync, readFileSync } from "node:fs";

import type { ToolDefinition, ToolResult } from "../types.js";
import { operationIdOf, sessionIdOf } from "../tool-execution/internal-args.js";
import { changesSinceOp } from "../autonomy/rollback-rewind.js";
import { evaluateFileAccess, loadFileAccessMode } from "../security/layer/index.js";
import { getRuntimeConfig } from "../config.js";
import { fileChangeOf } from "./file-change.js";

/** Diff lines shown in all, so one review stays readable. */
const MAX_TOTAL_LINES = 1500;

function readable(path: string, sessionId: string): boolean {
  return evaluateFileAccess(getRuntimeConfig().workspace, loadFileAccessMode(), () => false, "read", path, sessionId).allowed;
}

/** One file's section: its counts, then its hunks (as many as the budget allows). */
function section(path: string, before: string | null, budget: { lines: number }): string | null {
  if (!existsSync(path)) return before === null ? null : `${path}: deleted`;
  const after = readFileSync(path, "utf-8");
  if (after === before) return null; // changed and changed back
  if (after.includes("\0") || before?.includes("\0")) return `${path}: binary file changed`;
  const change = fileChangeOf(path, before, after);
  const head = `${path}${change.created ? " (new)" : ""}: +${change.added} -${change.removed}`;
  if (change.hunks === undefined) return `${head}\n  (contents not shown${change.added + change.removed > 0 ? ": a credential file, or too large to diff" : ""})`;
  const hunks: string[] = [];
  for (const h of change.hunks) {
    if (budget.lines <= 0) { hunks.push("  … (more not shown)"); break; }
    const lines = h.lines.slice(0, budget.lines);
    budget.lines -= lines.length;
    hunks.push(`@@ -${h.oldStart} +${h.newStart} @@\n${lines.join("\n")}`);
  }
  return `${head}${change.truncated ? " (diff cut)" : ""}\n${hunks.join("\n")}`;
}

export const reviewChangesTool: ToolDefinition = {
  name: "review_changes",
  compactDescription: "Every file you changed for this request, each with its diff. Review it before saying you're done.",
  description:
    "Review everything you changed for the current request before you say it's done: every file you wrote, edited or " +
    "created, each with its diff against what it held before the request. Use it to catch a stray edit, a leftover debug " +
    "line, or a file you forgot you touched. Read-only. A shell command's changes to files its text does not name are not " +
    "on record, so check those another way (git diff).",
  readOnly: true,
  concurrencySafe: true,
  parameters: { type: "object", properties: {} },
  async execute(args): Promise<ToolResult> {
    const sessionId = (sessionIdOf(args) ?? "").trim();
    const opId = (operationIdOf(args) ?? "").trim();
    if (!sessionId || !opId) return { content: "review_changes reviews a chat request's changes and needs one.", isError: true };
    const changes = changesSinceOp(sessionId, opId);
    if (changes.length === 0) return { content: "No file changes from this request are on record (a shell command's unnamed changes are not recorded)." };
    const budget = { lines: MAX_TOTAL_LINES };
    const sections = changes.flatMap(({ path, before }) => {
      if (!readable(path, sessionId)) return [`${path}: changed (not readable here)`];
      const s = section(path, before, budget);
      return s === null ? [] : [s];
    });
    if (sections.length === 0) return { content: "Every file this request changed is back to how it was." };
    return { content: `${sections.length} file${sections.length === 1 ? "" : "s"} changed for this request:\n\n${sections.join("\n\n")}` };
  },
};
