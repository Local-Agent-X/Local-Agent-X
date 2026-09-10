/**
 * Shared "what did this op actually change?" evidence collector for the
 * completion-gate audits (spec-audit.ts, regression-audit.ts). Extracted out
 * of spec-audit.ts so a second audit gate didn't have to fork this logic —
 * both gates need the identical answer to "show me the diff" and drift
 * between two copies is exactly the kind of thing that goes stale silently.
 *
 * Prefers `git diff HEAD` restricted to the edited paths (shows removals as
 * well as additions); when the project isn't a git repo, the diff errors, or
 * the work was already committed (empty diff), falls back to the final
 * contents of the first few edited files. Empty string → the caller's gate
 * stands down.
 */
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { bashTool } from "../../tools/shell-tool.js";
import { statusOf } from "../../tools/result-helpers.js";

const DIFF_TIMEOUT_MS = 20_000;
/** Paths handed to `git diff` / the contents fallback — beyond this a sweep is
 *  too wide for one audit context anyway; head of the list wins. */
const MAX_EVIDENCE_PATHS = 25;
const MAX_CONTENT_FILES = 3;

export function truncateHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.slice(limit).split("\n").length;
  return `${text.slice(0, limit)}\n… (truncated — ${dropped} more lines)`;
}

export async function collectDiffEvidence(
  absPaths: string[],
  evidenceLimit: number,
  signal?: AbortSignal,
): Promise<string> {
  const paths = absPaths.slice(0, MAX_EVIDENCE_PATHS);
  if (paths.length === 0) return "";
  try {
    const quoted = paths.map((p) => `"${p}"`).join(" ");
    const r = await bashTool.execute({
      command: `git diff HEAD -- ${quoted}`,
      _cwd: dirname(paths[0]),
      _signal: signal,
      timeout: DIFF_TIMEOUT_MS,
    });
    const diff = (r.content ?? "").trim();
    if (statusOf(r) === "ok" && diff.length > 0) {
      return truncateHead(diff, evidenceLimit);
    }
  } catch {
    // fall through to contents
  }
  const perFile = Math.floor(evidenceLimit / MAX_CONTENT_FILES);
  const parts: string[] = [];
  for (const p of paths.slice(0, MAX_CONTENT_FILES)) {
    try {
      const text = readFileSync(p, "utf-8");
      parts.push(`===== FINAL CONTENT: ${basename(p)} =====\n${truncateHead(text, perFile)}`);
    } catch {
      continue; // deleted/unreadable — nothing to show for it
    }
  }
  return parts.join("\n\n");
}
