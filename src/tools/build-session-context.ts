/**
 * Prior-build memory for build_app UPDATE flows.
 *
 * Every update used to start cold: a fresh op whose only context was a file
 * snapshot, so the "fixer" had no idea what the app was originally asked to
 * be or what the last build claimed to have done — it re-diagnosed from
 * scratch and tended to repeat the same wrong approach. This module gives an
 * update op the prior session's spine: for the most recent completed builds
 * of the SAME app, the brief that drove each one and the builder's final
 * report.
 *
 * Rendered as an `=== ... ===` block that rides the existing contextFiles
 * seam in renderPerBuildContext, so BOTH build strategies (cli-subprocess
 * and in-canonical) inherit it with no adapter changes. Pure renderers at
 * the bottom; the store-touching gatherer on top.
 */

import { listOps } from "../ops/op-store.js";
import { readOpMessages, firstUserMessageText } from "../canonical-loop/index.js";

/** Most recent prior builds included. Newest last (chronological read). */
const MAX_PRIOR_OPS = 3;
const BRIEF_CAP = 1_500;
const REPORT_CAP = 2_000;

export interface PriorBuildEntry {
  createdAt: string;
  /** "completed" | "failed" — a failed fix attempt is exactly what the next
   *  fixer must know about (so it doesn't repeat the same broken approach). */
  status: string;
  /** The user's build/update instruction that drove the op. */
  brief: string;
  /** The builder's final assistant message (its closing report). */
  finalReport: string;
}

/**
 * Collect the terminal prior build ops for an app, oldest→newest. Matched
 * by appUrl — unique per app directory and stamped on every app_build op.
 * `opType` is passed by the caller (build-app.ts owns APP_BUILD_OP_TYPE;
 * importing it here would be a cycle).
 */
export function gatherPriorBuildSessions(appUrl: string, opType: string): PriorBuildEntry[] {
  const prior = listOps()
    .filter((op) => op.type === opType && op.appUrl === appUrl
      && (op.status === "completed" || op.status === "failed"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_PRIOR_OPS);

  const entries: PriorBuildEntry[] = [];
  for (const op of prior) {
    const brief = extractBuildBrief(firstUserMessageText(op.id));
    const finalReport = lastAssistantText(op.id);
    if (!brief && !finalReport) continue;
    entries.push({
      createdAt: op.createdAt,
      status: op.status,
      brief: brief.slice(0, BRIEF_CAP),
      finalReport: finalReport.slice(0, REPORT_CAP),
    });
  }
  return entries;
}

/**
 * The seeded turn-0 user message is the whole rendered per-build context;
 * the actual ask lives on its `Instructions:` line. Pull just that; fall
 * back to the raw text when the shape is unfamiliar.
 */
export function extractBuildBrief(seededText: string): string {
  const m = seededText.match(/^Instructions: ([\s\S]*?)\n\nRULES:/m);
  return (m ? m[1] : seededText).trim();
}

function lastAssistantText(opId: string): string {
  const rows = readOpMessages(opId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role !== "assistant") continue;
    const c = row.content;
    const text = typeof c === "string"
      ? c
      : (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string")
        ? (c as { text: string }).text
        : "";
    if (text.trim()) return text.trim();
  }
  return "";
}

/**
 * Render the entries as one context block, or null when there's no history
 * (an app created before this feature, or pruned ops — the update then runs
 * exactly as it did before).
 */
export function renderPriorBuildBlock(entries: PriorBuildEntry[]): string | null {
  if (entries.length === 0) return null;
  const parts = entries.map((e) => {
    const day = e.createdAt.slice(0, 10);
    const tag = e.status === "failed" ? " (BUILD FAILED — do not repeat this approach)" : "";
    const lines = [`[${day}] brief: ${e.brief || "(unavailable)"}`];
    if (e.finalReport) lines.push(`[${day}] builder's final report${tag}: ${e.finalReport}`);
    return lines.join("\n");
  });
  return (
    `=== PRIOR BUILD SESSIONS (you are CONTINUING this app, not starting fresh) ===\n` +
    `This app was built through the session(s) below. Honor the original brief; ` +
    `treat past "final report" claims as UNVERIFIED — if the user is asking for a fix, ` +
    `something in them was wrong.\n\n${parts.join("\n\n")}`
  );
}

/** One-call convenience for build-app.ts: gather + render. */
export function renderPriorBuildContext(appUrl: string, opType: string): string | null {
  return renderPriorBuildBlock(gatherPriorBuildSessions(appUrl, opType));
}
