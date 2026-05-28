/**
 * Grep Tool — content search via ripgrep (rg) with Node.js fallback.
 * The primary tool for navigating and searching code.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";

type OutputMode = "content" | "files_with_matches" | "count";

const DEFAULT_HEAD_LIMIT = 250;

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

function truncate(lines: string[], limit: number): string {
  if (lines.length <= limit) return lines.join("\n");
  return lines.slice(0, limit).join("\n") + `\n... (${lines.length - limit} more lines)`;
}

// ── ripgrep path ──

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

  rg.push(pattern, String(args.path || process.cwd()));
  return rg;
}

function runRg(args: Record<string, unknown>, limit: number, signal?: AbortSignal): Promise<ToolResult> {
  const rgArgs = buildRgArgs(args);
  return new Promise((resolve, reject) => {
    const child = execFile("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout) => {
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
        const re = new RegExp("^" + globFilter.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        if (!re.test(e.name)) continue;
      }
      yield full;
    }
  }
}

async function fallbackSearch(args: Record<string, unknown>, limit: number): Promise<ToolResult> {
  const pattern = new RegExp(String(args.pattern), args.case_insensitive ? "i" : "");
  const mode = (args.output_mode as OutputMode) || "files_with_matches";
  const ctx = typeof args.context === "number" ? (args.context as number) : 0;
  const root = String(args.path || process.cwd());
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
