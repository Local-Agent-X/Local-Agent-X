/**
 * Glob Tool -- file pattern matching for agents.
 * Replaces bash find/ls with structured glob results sorted by mtime.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import fg from "fast-glob";
import type { ToolDefinition, ToolResult } from "./types.js";

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

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

    const cwd = resolve(String(args.path ?? process.cwd()));

    try {
      const entries = await globFiles(pattern, cwd, 200);
      if (entries.length === 0) return ok("No files matched.");

      const lines = entries.map((e) => `${e.path}  (${humanSize(e.size)})`);
      return ok(lines.join("\n"));
    } catch (e: unknown) {
      return err(`Glob failed: ${e instanceof Error ? e.message : String(e)}`);
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
