/**
 * External-change diffs — each turn after tool dispatch, sweep the files this
 * op's SESSION has read (the read-state freshness map) for content that
 * changed on disk OUTSIDE the turn's own tool calls — an editor save, another
 * agent, a build step — and inject compact unified diffs against the session's
 * cached view, so the model updates its mental model without a full re-read.
 *
 * Baseline strategy: the content snapshot read-state captured AT READ TIME is
 * "before"; current disk is "after". A baseline is unknowable at injection
 * time (same reasoning as post-edit-diagnostics' baselines), so the diff is
 * only as good as the snapshot — files whose snapshot was skipped (too large)
 * or LRU-evicted get an honest "changed, re-read it" notice instead.
 *
 * State lives in read-state (per SESSION, the same map the stale-read edit
 * gate uses), not in per-op middleware state: the session is the boundary that
 * owns "what has this conversation seen", and read-state already clears it on
 * session end. A change surfaced with its FULL diff adopts the disk state as
 * the session's baseline (never re-notifies, and the edit gate treats the file
 * as seen); a truncated or diff-less notice suppresses re-notification only —
 * the edit gate still forces a real re-read of bytes the model never saw.
 *
 * Fail-open everywhere: a sweep fault logs a warning and the turn proceeds
 * untouched. Disable with LAX_EXTERNAL_CHANGE_DIFF=0.
 */
import { createPatch } from "diff";
import type { CanonicalLoopContext, CanonicalMiddleware } from "./types.js";
import { isDispatchFailure } from "../types.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { sweepExternalChanges, resolveExternalChange, type ExternalChange } from "../../tools/read-state.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.external-change-diff");

/** Cap on files reported in one nudge — the overflow re-notifies next sweep. */
const MAX_FILES_PER_NUDGE = 5;
/** Cap on diff lines shown per file. A capped diff is honest about it and
 *  does NOT count as the model having seen the full change. */
const MAX_DIFF_LINES_PER_FILE = 40;

/** Resolved paths of files touched by this turn's SUCCESSFUL tool calls —
 *  exempt from the sweep. The write/edit path re-records its own result in
 *  read-state, so self-inflicted changes must never read as "external". */
function touchedFiles(ctx: CanonicalLoopContext): string[] {
  const statusById = new Map(ctx.toolResults.map((tr) => [tr.toolCallId, tr.status]));
  const out: string[] = [];
  for (const tc of ctx.toolCalls) {
    const status = statusById.get(tc.toolCallId);
    if (isDispatchFailure(status) || status === "cancelled") continue;
    const args = (tc.args ?? {}) as Record<string, unknown>;
    const raw =
      typeof args.file_path === "string" ? args.file_path
      : typeof args.path === "string" ? args.path
      : undefined;
    if (!raw) continue;
    try {
      const resolved = resolveAgentPath(raw);
      if (!out.includes(resolved)) out.push(resolved);
    } catch { /* an unresolvable arg can't match a tracked key */ }
  }
  return out;
}

/** Unified-diff body for one change, capped. null when no diff is possible
 *  (missing snapshot). `full` is false when lines were truncated. */
function fileDiff(change: ExternalChange): { text: string; full: boolean } | null {
  if (change.before === undefined || change.after === undefined) return null;
  const patch = createPatch(change.path, change.before, change.after, "", "", { context: 3 });
  const lines = patch.split("\n");
  const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
  if (hunkStart < 0) return null; // no hunks — degrade to the diff-less notice
  const body = lines.slice(hunkStart);
  if (body.length <= MAX_DIFF_LINES_PER_FILE) return { text: body.join("\n"), full: true };
  const elided = body.length - MAX_DIFF_LINES_PER_FILE;
  return {
    text: [
      ...body.slice(0, MAX_DIFF_LINES_PER_FILE),
      `… ${elided} more diff line${elided === 1 ? "" : "s"} truncated — re-read the file for the full change …`,
    ].join("\n"),
    full: false,
  };
}

export const externalChangeDiffMiddleware: CanonicalMiddleware = {
  name: "external-change-diff",

  // afterToolExecution — the same injection channel post-edit-diagnostics
  // uses: the nudge lands as a user op_message the model sees next step.
  afterToolExecution(ctx) {
    if (process.env.LAX_EXTERNAL_CHANGE_DIFF === "0") return { kind: "continue" };
    try {
      const sessionId = getSessionForOp(ctx.op.id);
      if (!sessionId) return { kind: "continue" }; // untracked op → no session map to sweep
      const changes = sweepExternalChanges(sessionId, touchedFiles(ctx));
      if (changes.length === 0) return { kind: "continue" };

      const shown = changes.slice(0, MAX_FILES_PER_NUDGE);
      const sections: string[] = [];
      for (const change of shown) {
        const diff = fileDiff(change);
        if (diff) {
          sections.push(`${change.path} changed:\n${diff.text}`);
        } else {
          sections.push(
            `${change.path} changed on disk (no diff available — the cached snapshot was too large or evicted). ` +
            `Re-read it before relying on or editing its contents.`,
          );
        }
        resolveExternalChange(sessionId, change, diff?.full ?? false);
      }
      const overflow =
        changes.length > shown.length
          ? `\n\n(+${changes.length - shown.length} more changed file${changes.length - shown.length === 1 ? "" : "s"} not shown — they will be reported on a later turn.)`
          : "";
      return {
        kind: "nudge",
        reason: "external-change-diff",
        message:
          "Files you read earlier in this session have changed on disk OUTSIDE your own tool calls. " +
          "Your cached view of them is stale — each diff below is what changed (old = what you last saw, new = current disk):\n\n" +
          sections.join("\n\n") +
          overflow,
      };
    } catch (err) {
      // Fail-open: the sweep is advisory; a fault must never block the turn.
      logger.warn(
        `fail-open: external-change sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "continue" };
    }
  },
};
