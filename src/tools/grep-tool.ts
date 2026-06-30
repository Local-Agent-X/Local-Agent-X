/**
 * Grep Tool — content search via ripgrep (rg) with Node.js fallback.
 * The primary tool for navigating and searching code.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveAgentPath } from "../workspace/paths.js";

type OutputMode = "content" | "files_with_matches" | "count";

// Resolve the search root through the canonical agent-path resolver — the SAME
// one read/glob and the security gate use — so a "~/..." or workspace-relative
// root expands once, identically to how it's gated, instead of being joined
// onto a raw cwd and failing until the model retries. Absent path → cwd.
export function searchRoot(args: Record<string, unknown>): string {
  return args.path != null && String(args.path) !== ""
    ? resolveAgentPath(String(args.path))
    : process.cwd();
}

const DEFAULT_HEAD_LIMIT = 250;

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

function truncate(lines: string[], limit: number): string {
  if (lines.length <= limit) return lines.join("\n");
  return lines.slice(0, limit).join("\n") + `\n... (${lines.length - limit} more lines)`;
}

// ── ripgrep path ──

// Resolve the ripgrep binary. The desktop app bundles `rg` and the Electron
// main hands its resources dir to the server in LAX_BUNDLED_BIN_DIR — prefer
// that absolute path, because a Finder-launched app gets a minimal launchd PATH
// where a bare `rg` isn't found (which is why this silently fell to the slow
// Node search). Dev / source installs have no bundle, so fall back to `rg` on
// PATH; runRg then falls back to the Node search if even that is absent.
export function ripgrepBin(): string {
  const bundled = process.env.LAX_BUNDLED_BIN_DIR;
  if (bundled) {
    const p = join(bundled, process.platform === "win32" ? "rg.exe" : "rg");
    if (existsSync(p)) return p;
  }
  return "rg";
}

function buildRgArgs(args: Record<string, unknown>): string[] {
  const pattern = String(args.pattern);
  const mode = (args.output_mode as OutputMode) || "files_with_matches";
  const ctx = typeof args.context === "number" ? args.context : undefined;
  const rg: string[] = ["--no-heading", "--color", "never"];

  if (args.case_insensitive) rg.push("-i");
  if (args.type) rg.push("--type", String(args.type));
  if (args.glob) rg.push("--glob", String(args.glob));

  if (mode === "files_with_matches") rg.push("-l");
  else if (mode === "count") rg.push("-c");
  else if (mode === "content") { rg.push("-n"); if (ctx !== undefined) rg.push("-C", String(ctx)); }

  rg.push(pattern, searchRoot(args));
  return rg;
}

function runRg(args: Record<string, unknown>, limit: number, signal?: AbortSignal): Promise<ToolResult> {
  const rgArgs = buildRgArgs(args);
  return new Promise((resolve, reject) => {
    const child = execFile(ripgrepBin(), rgArgs, { maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout) => {
      if (signal?.aborted) return resolve(err("Aborted"));
      // ENOENT = rg not found in PATH — reject so fallback kicks in
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
      const out = (stdout || "").trim();
      // rg exits with code 1 when no matches — that's not an error
      if (!out) return resolve(ok("No matches found."));
      resolve(ok(truncate(out.split("\n"), limit)));
    });
    child.stdin?.end();
  });
}

// ── Node.js fallback ──

async function* walkDir(dir: string, typeFilter?: string, globFilter?: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
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

async function fallbackSearch(args: Record<string, unknown>, limit: number): Promise<ToolResult> {
  let pattern: RegExp;
  try {
    const { source, flags } = parsePattern(String(args.pattern), Boolean(args.case_insensitive));
    pattern = new RegExp(source, flags);
  } catch (e) {
    return err(
      `Invalid regex pattern: ${(e as Error).message}. ` +
      "Tip: use the case_insensitive option instead of an inline (?i) flag.",
    );
  }
  const mode = (args.output_mode as OutputMode) || "files_with_matches";
  const ctx = typeof args.context === "number" ? (args.context as number) : 0;
  const root = searchRoot(args);
  const lines: string[] = [];
  const onProgress = args._onProgress as ((msg: string) => void) | undefined;

  const rootStat = await stat(root).catch(() => null);
  const files = rootStat?.isFile() ? [root] : walkDir(root, args.type as string, args.glob as string);

  let scanned = 0;
  for await (const file of files) {
    if (lines.length >= limit) break;
    scanned++;
    if (onProgress && scanned % 50 === 0) onProgress(`Searched ${scanned} files, ${lines.length} results so far...`);
    let content: string;
    try { content = await readFile(file, "utf-8"); } catch { continue; }
    const fileLines = content.split("\n");
    const matches = fileLines.map((l, i) => pattern.test(l) ? i : -1).filter((i) => i >= 0);
    if (matches.length === 0) continue;

    if (mode === "files_with_matches") { lines.push(file); continue; }
    if (mode === "count") { lines.push(`${file}:${matches.length}`); continue; }
    for (const idx of matches) {
      const start = Math.max(0, idx - ctx);
      const end = Math.min(fileLines.length - 1, idx + ctx);
      for (let i = start; i <= end; i++) lines.push(`${file}:${i + 1}:${fileLines[i]}`);
      if (ctx > 0) lines.push("--");
    }
  }

  return ok(lines.length === 0 ? "No matches found." : truncate(lines, limit));
}

// ── Tool definition ──

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents using regex. Uses ripgrep when available, falls back to Node.js recursive search. " +
    "Supports file type and glob filtering, context lines, and three output modes.",
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
      context:          { type: "number", description: "Lines of context around each match" },
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
  return "ALWAYS use grep for content search. NEVER use bash grep/rg. Supports regex, file type filtering, multiple output modes.";
}
