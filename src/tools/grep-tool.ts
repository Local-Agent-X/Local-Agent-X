/**
 * Grep Tool — content search via ripgrep (rg) with Node.js fallback.
 * The primary tool for navigating and searching code.
 *
 * The Node fallback engine and the shared result-shaping helpers live in
 * grep-context.ts; the public seams are re-exported here so this file stays
 * the one canonical import home for grep.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import {
  baseMeta,
  contextLines,
  fallbackSearch,
  modeOf,
  resultMeta,
  searchRoot,
  truncate,
} from "./grep-context.js";

export { searchRoot, parsePattern, fallbackSearch } from "./grep-context.js";

const DEFAULT_HEAD_LIMIT = 250;

// ── ripgrep path ──

// The @vscode/ripgrep binary in node_modules, resolved once. Reaches OTA users
// — a source-update's npm sync installs the dep — plus dev and source installs,
// none of which have the packaged .app's bundled copy. Null when the per-OS
// package isn't installed; the caller then falls through to `rg` on PATH.
let cachedNodeModulesRg: string | null | undefined;
function nodeModulesRg(): string | null {
  if (cachedNodeModulesRg !== undefined) return cachedNodeModulesRg;
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const spec = `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${exe}`;
  let p: string | null = null;
  try {
    p = fileURLToPath(import.meta.resolve(spec));
  } catch {
    // import.meta.resolve is runtime-dependent (tsx/loaders intercept it and
    // can refuse extensionless binary subpaths plain node accepts). CJS
    // resolution has no such hook — fall through so dev-runtime servers still
    // find the binary instead of silently degrading to bare `rg`.
    try {
      p = createRequire(import.meta.url).resolve(spec);
    } catch {
      p = null;
    }
  }
  cachedNodeModulesRg = p !== null && existsSync(p) ? p : null;
  return cachedNodeModulesRg;
}

// Resolve the ripgrep binary, by how reliably each source is present:
//   1. the signed copy in the packaged .app (LAX_BUNDLED_BIN_DIR, set by the
//      Electron main) — a Finder-launched app's minimal launchd PATH can't find
//      a bare `rg`, which is why grep used to fall to the slow Node search;
//   2. @vscode/ripgrep in node_modules — reaches OTA users, dev, source installs;
//   3. `rg` on PATH; then runRg falls back to the Node search if even that is gone.
export function ripgrepBin(): string {
  const bundled = process.env.LAX_BUNDLED_BIN_DIR;
  if (bundled) {
    const p = join(bundled, process.platform === "win32" ? "rg.exe" : "rg");
    if (existsSync(p)) return p;
  }
  return nodeModulesRg() ?? "rg";
}

/** Filter flags shared by the search pass and the exact-count pass. */
function baseRgArgs(args: Record<string, unknown>): string[] {
  const rg: string[] = ["--no-heading", "--color", "never"];
  if (args.case_insensitive) rg.push("-i");
  if (args.type) rg.push("--type", String(args.type));
  if (args.glob) rg.push("--glob", String(args.glob));
  return rg;
}

function buildRgArgs(args: Record<string, unknown>): string[] {
  const mode = modeOf(args);
  const rg = baseRgArgs(args);

  if (mode === "files_with_matches") rg.push("-l");
  else if (mode === "count") rg.push("-c");
  else if (mode === "content") {
    rg.push("-n");
    const ctx = contextLines(args, mode);
    // ctx 0 (explicit) omits -C entirely: plain `file:line:text`, no `--`
    // separators — identical to the pre-default behavior.
    if (ctx > 0) rg.push("-C", String(ctx));
  }

  // `--` ends option parsing so a pattern (or path) that begins with a dash —
  // e.g. a CSS custom-property search like `--(color|brand)` — is never
  // mistaken for a flag.
  rg.push("--", String(args.pattern), searchRoot(args));
  return rg;
}

/** Same pattern/filters/root as the search pass, but `-c` (matched-line
 *  counts per file). Feeds the exact match_count for context-mode results. */
function buildRgCountArgs(args: Record<string, unknown>): string[] {
  const rg = baseRgArgs(args);
  rg.push("-c", "--", String(args.pattern), searchRoot(args));
  return rg;
}

/** execFile's error, as Node actually shapes it: `code` is the exit code
 *  (number) for a spawn that ran, or an errno string (ENOENT, maxBuffer). */
type ExecError = Error & { code?: number | string | null };

/** Injectable exec seam (tests stub it; production uses node's execFile). */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { maxBuffer: number; signal?: AbortSignal },
  callback: (error: ExecError | null, stdout: string, stderr: string) => void,
) => { stdin?: { end(): void } | null };

/** Thin adapter pinning node's execFile to the one overload the seam uses. */
const defaultExec: ExecFileLike = (file, args, options, callback) =>
  execFile(file, [...args], options, callback);

/** One rg invocation through the injectable seam; never rejects — callers
 *  discriminate on the returned error. */
function execRgOnce(
  exec: ExecFileLike,
  rgArgs: string[],
  signal?: AbortSignal,
): Promise<{ error: ExecError | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = exec(ripgrepBin(), rgArgs, { maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr }));
    child.stdin?.end();
  });
}

/**
 * Exact matched-line count for context-mode results. The rendered stream mixes
 * match lines (`path:N:text`) with context lines (`path-N-text`) whose TEXT
 * can itself embed `:12:`-shaped locators (timestamps, stack traces, source
 * refs), so no per-line parse of the rendered output is robust — ask rg itself
 * with a second `-c` pass over the identical pattern/filters/root. Its `path:N`
 * lines parse on the LAST colon, immune to Windows drive letters. Returns null
 * (metadata omitted) on any anomaly — an honest gap beats an inflated count.
 *
 * ACCEPTED TRADE-OFF — do NOT "optimize" this second spawn away: it costs
 * milliseconds against the multi-second inference round trips the turn-cost
 * campaign attacks, and the count the model plans against must be correct.
 */
async function rgMatchCount(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  exec: ExecFileLike = defaultExec,
): Promise<number | null> {
  const { error, stdout } = await execRgOnce(exec, buildRgCountArgs(args), signal);
  const out = (stdout || "").trim();
  const code = error?.code;
  // Exit 2 WITH output = counts for the readable subtree (mirrors the
  // partial-results branch of the search pass); any other error is an anomaly.
  if (!out || (error && code !== 1 && code !== 2)) return null;
  let total = 0;
  for (const line of out.split("\n")) {
    const n = Number(line.slice(line.lastIndexOf(":") + 1));
    if (!Number.isInteger(n) || n < 0) return null;
    total += n;
  }
  return total;
}

/** Exported for tests — the tool routes searches through this. */
export async function runRg(
  args: Record<string, unknown>,
  limit: number,
  signal?: AbortSignal,
  exec: ExecFileLike = defaultExec,
): Promise<ToolResult> {
  const { error, stdout, stderr } = await execRgOnce(exec, buildRgArgs(args), signal);
  if (signal?.aborted) return err("Aborted", baseMeta(args));
  // Error discrimination (rg's documented exit codes): 1 = no matches
  // (not a failure); ENOENT = rg not installed (reject → Node fallback);
  // maxBuffer overflow = usable-but-truncated output; anything else
  // (exit 2 = bad regex / unreadable path, other errnos) is a real error —
  // never round it down to "No matches found."
  const code = error?.code;
  const truncated = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const out = (stdout || "").trim();
  const snippet = (stderr || "").trim().split("\n")[0]?.slice(0, 300) ?? "";
  if (error && code === "ENOENT") throw error;
  // rg exits 2 whenever ANY error occurred during the search — even when
  // it found and printed real matches (e.g. one unreadable subdirectory in
  // an otherwise-searchable tree). Partial results are results: return
  // them with a warning. Only exit 2 with EMPTY stdout is a hard failure.
  const partial = code === 2 && out !== "";
  if (error && code !== 1 && !truncated && !partial) {
    return err(
      `grep failed: ripgrep exited with ${String(code ?? error.message)}` +
      (snippet ? ` — ${snippet}` : ""),
      baseMeta(args),
    );
  }
  // rg exits with code 1 when no matches — that's not an error. Kept
  // LEGACY-shaped (no metadata) deliberately: with metadata the renderer
  // prepends a status header, and two guards match the RENDERED content
  // with start-anchored regexes — isEmptyGrepResult (agent-guards/
  // cleanup-verify.ts) and EMPTY_RESULT_RE (errors/classifier.ts, feeds
  // the dead-end detector). Verbatim keeps the sentinel parseable, and a
  // headerless result already parses as status "ok", which is correct.
  if (!out) return ok("No matches found.");
  const allLines = out.split("\n");
  const body = truncate(allLines, limit);
  const warning = truncated
    ? "\nWARNING: output exceeded the buffer cap — this list is TRUNCATED; narrow the path or use a more specific pattern."
    : partial
      ? `\nWARNING: some paths could not be searched${snippet ? ` (${snippet})` : ""} — results may be incomplete.`
      : "";
  const mode = modeOf(args);
  // ctx 0 renders match lines only, so the rendered line count IS the exact
  // match count; with context the exact count comes from the second -c pass.
  const matchCount = mode !== "content" ? undefined
    : contextLines(args, mode) === 0 ? allLines.length
    : await rgMatchCount(args, signal, exec);
  const meta = resultMeta(args, allLines, truncated || allLines.length > limit, matchCount);
  if (partial) meta.partial = true;
  return ok(body + warning, meta);
}

// ── Tool definition ──

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents using regex. Uses ripgrep when available, falls back to Node.js recursive search. " +
    "Supports file type and glob filtering, and three output modes. In content mode each hit includes " +
    "4 surrounding lines of context by default (override with `context`; 0 = match lines only), so one " +
    "call usually answers where AND what — follow-up reads of hit files are rarely needed.",
  readOnly: true,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      pattern:          { type: "string", description: "Regex pattern to search for" },
      path:             { type: "string", description: "File or directory to search (defaults to cwd)" },
      type:             { type: "string", description: "File type filter, e.g. 'ts', 'py', 'js'" },
      glob:             { type: "string", description: "Glob pattern to filter files, e.g. '*.tsx'" },
      output_mode:      { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode (default: files_with_matches)" },
      context:          { type: "number", description: "Lines of context around each match (content mode defaults to 4; pass 0 for match lines only)" },
      head_limit:       { type: "number", description: "Max output lines (default 250)" },
      case_insensitive: { type: "boolean", description: "Case insensitive search" },
    },
    required: ["pattern"],
  },
  async execute(args, signal) {
    if (!args.pattern || String(args.pattern).trim() === "") return err("pattern is required");
    const limit = typeof args.head_limit === "number" ? args.head_limit : DEFAULT_HEAD_LIMIT;
    try {
      return await runRg(args, limit, signal);
    } catch {
      return fallbackSearch(args, limit);
    }
  },
};

export const grepToolEnhancements = {
  category: "search" as const,
  tags: ["search", "find", "regex", "grep", "content"],
  readOnly: true,
  concurrencySafe: true,
  searchHint: "search file contents regex pattern grep ripgrep",
};

export function prompt(): string {
  return "ALWAYS use grep for content search. NEVER use bash grep/rg. Supports regex, file type filtering, multiple output modes. content-mode hits include surrounding context lines — answer from them instead of reading each hit file.";
}
