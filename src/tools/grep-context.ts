/**
 * Grep fallback engine + shared result shaping for the grep tool.
 *
 * Home of the pure-Node search that runs when the ripgrep binary is missing
 * entirely, plus the arg/metadata helpers both search paths share. Split out
 * of grep-tool.ts (400-LOC ceiling); grep-tool.ts re-exports the public
 * seams (searchRoot, parsePattern, fallbackSearch) so import sites keep one
 * canonical home.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { resolveAgentPath, sessionIdOf, sessionWorkRootOf } from "../workspace/paths.js";

export type OutputMode = "content" | "files_with_matches" | "count";

// Resolve the search root through the canonical agent-path resolver — the SAME
// one read/glob and the security gate use — so a "~/..." or workspace-relative
// root expands once, identically to how it's gated, instead of being joined
// onto a raw cwd and failing until the model retries. Absent path → the
// session's work root when one is registered (a chunk worker's bare grep must
// search its project, not the server cwd), else cwd.
export function searchRoot(args: Record<string, unknown>): string {
  const sessionId = sessionIdOf(args);
  return args.path != null && String(args.path) !== ""
    ? resolveAgentPath(String(args.path), sessionId)
    : sessionWorkRootOf(sessionId) ?? process.cwd();
}

// content mode includes this much surrounding context per hit unless the
// caller passes `context` explicitly (0 restores bare match lines). 4 lines
// each side shows the enclosing statement/signature (~9 lines per hit) — one
// grep answers "where AND what" instead of costing a follow-up read round
// trip per hit file — while the default head_limit of 250 still fits ~25 hits.
export const DEFAULT_CONTENT_CONTEXT = 4;

export function modeOf(args: Record<string, unknown>): OutputMode {
  return (args.output_mode as OutputMode) || "files_with_matches";
}

/** Explicit caller context wins (including 0); content mode defaults to 4. */
export function contextLines(args: Record<string, unknown>, mode: OutputMode): number {
  if (typeof args.context === "number") return args.context;
  return mode === "content" ? DEFAULT_CONTENT_CONTEXT : 0;
}

export function truncate(lines: string[], limit: number): string {
  if (lines.length <= limit) return lines.join("\n");
  return lines.slice(0, limit).join("\n") + `\n... (${lines.length - limit} more lines)`;
}

/** Envelope metadata: what was searched, how much came back, whether it was cut. */
export function resultMeta(
  args: Record<string, unknown>,
  resultLines: string[],
  truncated: boolean,
  matchCount?: number | null,
  fileCount?: number,
): Record<string, unknown> {
  const mode = modeOf(args);
  const meta: Record<string, unknown> = { pattern: String(args.pattern), mode };
  if (mode === "content") {
    // Exact counts only, computed from match data — the fallback counts its
    // per-file match arrays; the rg path asks rg itself with a second `-c`
    // pass. NEVER derived by regexing the rendered lines: context text
    // routinely embeds `:12:`-shaped locators (timestamps, stack traces,
    // source refs) that inflate such a count. Omitted entirely when no exact
    // count is available — an honest gap beats an inflated number.
    if (matchCount != null) meta.match_count = matchCount;
  } else {
    // fileCount (fallback) covers the FULL walk even when rendering was
    // capped by head_limit; the rg path's resultLines are already the full
    // pre-truncation output, so its length is exact there.
    meta.file_count = fileCount ?? resultLines.length;
  }
  if (truncated) meta.truncated = true;
  return meta;
}

export function baseMeta(args: Record<string, unknown>): Record<string, unknown> {
  return { pattern: String(args.pattern), mode: modeOf(args) };
}

// JS RegExp rejects ripgrep/PCRE-style inline flags like `(?i)` with "Invalid
// group", so a case-insensitive search ripgrep accepts dies only when rg is
// absent and this fallback runs. Lift a LEADING inline-flag group into real
// RegExp flags (merging the case_insensitive option) so the two paths behave
// alike. Exported for testing.
export function parsePattern(raw: string, caseInsensitive: boolean): { source: string; flags: string } {
  const flags = new Set<string>();
  if (caseInsensitive) flags.add("i");
  let source = raw;
  const lead = /^\(\?([ims]+)\)/.exec(source);
  if (lead) {
    for (const f of lead[1]) flags.add(f);
    source = source.slice(lead[0].length);
  }
  return { source, flags: [...flags].join("") };
}

// Fallback walk. Divergences from rg, accepted because this path runs ONLY
// when the rg binary is missing entirely:
//   - rg honors .gitignore/.ignore inside git repos. Faithful gitignore
//     semantics (nested files, negation, anchoring, repo detection) are not
//     cheap, and a partial imitation would silently differ in worse ways —
//     only node_modules/.git are skipped here.
//   - rg's multi-file emission order is unspecified under its parallel walk
//     (observed non-alphabetical); this walk sorts entries so fallback output
//     is at least deterministic.
async function* walkDir(dir: string, typeFilter?: string, globFilter?: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      yield* walkDir(full, typeFilter, globFilter);
    } else if (e.isFile()) {
      if (typeFilter && extname(e.name).slice(1) !== typeFilter) continue;
      if (globFilter) {
        // Escape every regex metacharacter first (so `+`, `(`, `[`… in a glob
        // are literal), THEN turn the surviving `*` into `.*`. The old version
        // only escaped `.`, so other metachars leaked into the pattern.
        const escaped = globFilter.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        const re = new RegExp("^" + escaped + "$");
        if (!re.test(e.name)) continue;
      }
      yield full;
    }
  }
}

/** Exported for tests — runs when the ripgrep binary is missing entirely. */
export async function fallbackSearch(args: Record<string, unknown>, limit: number): Promise<ToolResult> {
  let pattern: RegExp;
  try {
    const { source, flags } = parsePattern(String(args.pattern), Boolean(args.case_insensitive));
    pattern = new RegExp(source, flags);
  } catch (e) {
    return err(
      `Invalid regex pattern: ${(e as Error).message}. ` +
      "Tip: use the case_insensitive option instead of an inline (?i) flag.",
      baseMeta(args),
    );
  }
  const mode = modeOf(args);
  const ctx = contextLines(args, mode);
  const root = searchRoot(args);
  const lines: string[] = [];
  let matchTotal = 0;
  let fileCount = 0;
  let needSep = false;
  // Rendering stops at the head_limit budget, but the walk NEVER does: the rg
  // path's counts ignore head_limit (-c pass; full pre-truncation output), and
  // the fallback's match_count/file_count must agree with them — a truncated
  // fallback run used to report the rendered-so-far count as if it were the
  // total. This path only runs when rg is missing, so finishing the scan in
  // count-only mode (no context assembly, no block rendering) is an accepted
  // cost. Divergence that remains: the "(N more lines)" truncation notice
  // undercounts here (only the rendered overshoot), where rg's is exact —
  // metadata.truncated is the honest signal on both paths.
  let rendering = true;
  let renderCut = false;
  const onProgress = args._onProgress as ((msg: string) => void) | undefined;

  const rootStat = await stat(root).catch(() => null);
  const files = rootStat?.isFile() ? [root] : walkDir(root, args.type as string, args.glob as string);

  let scanned = 0;
  for await (const file of files) {
    if (lines.length >= limit) rendering = false;
    scanned++;
    if (onProgress && scanned % 50 === 0) onProgress(`Searched ${scanned} files, ${lines.length} results so far...`);
    let content: string;
    try { content = await readFile(file, "utf-8"); } catch { continue; }
    // rg suppresses binary files during directory traversal (verified against
    // the real binary: a NUL-containing file whose bytes match the pattern
    // prints NOTHING) — mirror it with the NUL heuristic instead of rendering
    // raw control bytes as context. Edge divergence: when the binary file is
    // itself the explicit root, rg may print a "binary file matches" notice;
    // the fallback stays silent.
    if (content.includes("\0")) continue;
    const fileLines = content.split("\n");
    // A trailing newline leaves a phantom "" element that rg never prints —
    // a match within `ctx` of EOF used to drag it in as a bogus context line
    // numbered one past the end of the file.
    if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") fileLines.pop();
    const matches = fileLines.map((l, i) => (pattern.test(l) ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 0) continue;
    matchTotal += matches.length;
    fileCount++;
    if (!rendering) { renderCut = true; continue; }

    if (mode === "files_with_matches") { lines.push(file); continue; }
    if (mode === "count") { lines.push(`${file}:${matches.length}`); continue; }
    // Mirror rg's context rendering exactly so the two paths are
    // indistinguishable to the model: overlapping/abutting context windows
    // merge into one block (no repeated lines), match lines keep `:`
    // separators while context lines use `-`, and `--` separates
    // non-contiguous blocks — including across files, as rg --no-heading does.
    const matchSet = new Set(matches);
    const blocks: Array<[number, number]> = [];
    for (const idx of matches) {
      const start = Math.max(0, idx - ctx);
      const end = Math.min(fileLines.length - 1, idx + ctx);
      const last = blocks[blocks.length - 1];
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else blocks.push([start, end]);
    }
    for (const [start, end] of blocks) {
      if (ctx > 0 && needSep) lines.push("--");
      needSep = true;
      for (let i = start; i <= end; i++) {
        const sep = matchSet.has(i) ? ":" : "-";
        lines.push(`${file}${sep}${i + 1}${sep}${fileLines[i]}`);
      }
    }
  }

  // Zero-match result stays legacy-shaped — same anchored-sentinel reasoning
  // as the rg path in grep-tool.ts.
  if (matchTotal === 0) return ok("No matches found.");
  return ok(
    truncate(lines, limit),
    resultMeta(args, lines, lines.length > limit || renderCut, matchTotal, fileCount),
  );
}
