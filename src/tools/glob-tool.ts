/**
 * Glob Tool -- file pattern matching for agents.
 * Replaces bash find/ls with structured glob results sorted by mtime.
 */
import { stat } from "node:fs/promises";
import fg from "fast-glob";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { resolveAgentPath, sessionIdOf, sessionWorkRootOf } from "../workspace/paths.js";

// Resolve the search base through the canonical agent-path resolver — the SAME
// one read/grep and the security gate use — so a "~/..." or workspace-relative
// base expands once, identically to how it's gated, instead of being joined
// onto a raw cwd and failing until the model retries. Absent path → the
// session's work root when one is registered (a chunk worker's bare
// glob("**/*.ts") must search its project, not the server cwd), else cwd.
// Exported for direct testing (guards against a regression back to a cwd join).
export function searchBase(rawPath: unknown, sessionId?: string): string {
  return rawPath != null && String(rawPath) !== ""
    ? resolveAgentPath(String(rawPath), sessionId)
    : sessionWorkRootOf(sessionId) ?? process.cwd();
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

interface FileEntry { path: string; mtime: number; size: number }

async function globFiles(pattern: string, cwd: string, limit: number): Promise<FileEntry[]> {
  const paths = await fg(pattern, {
    cwd,
    dot: false,
    onlyFiles: true,
    absolute: true,
    suppressErrors: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/vendor/**", "**/.next/**", "**/__pycache__/**"],
  });

  const entries: FileEntry[] = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      entries.push({ path: p, mtime: s.mtimeMs, size: s.size });
    } catch { /* skip inaccessible files */ }
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, limit);
}

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Fast file pattern matching. Returns files matching a glob pattern, sorted by modification time (newest first). " +
    "Supports patterns like **/*.ts, src/**/*.tsx, *.json.",
  readOnly: true,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/*.tsx")',
      },
      path: {
        type: "string",
        description: "Directory to search in. Defaults to current working directory.",
      },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return err("pattern is required");

    const cwd = searchBase(args.path, sessionIdOf(args));
    const startMs = Date.now();

    try {
      const entries = await globFiles(pattern, cwd, 200);
      const durationMs = Date.now() - startMs;
      if (entries.length === 0) return ok("No files matched.", { pattern, cwd, count: 0, duration_ms: durationMs });

      const lines = entries.map((e) => `${e.path}  (${humanSize(e.size)})`);
      return ok(lines.join("\n"), {
        pattern,
        cwd,
        count: entries.length,
        capped: entries.length === 200 || undefined,
        duration_ms: durationMs,
      });
    } catch (e: unknown) {
      return err(`Glob failed: ${e instanceof Error ? e.message : String(e)}`, {
        pattern,
        cwd,
        duration_ms: Date.now() - startMs,
      });
    }
  },
};

export const globToolEnhancements = {
  category: "search" as const,
  tags: ["file", "find", "pattern", "glob"],
  readOnly: true,
  concurrencySafe: true,
  searchHint: "find files by name pattern glob",
  prompt,
};

export function prompt(): string {
  return [
    "Use the glob tool for fast file pattern matching instead of bash find/ls.",
    "Supports patterns like **/*.ts, src/**/*.tsx, *.json.",
    "Results are sorted by modification time (newest first), limited to 200.",
    "Provide an optional path to search in a specific directory.",
  ].join("\n");
}
