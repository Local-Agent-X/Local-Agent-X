/**
 * Glob Tool -- file pattern matching for agents.
 * Replaces bash find/ls with structured glob results sorted by mtime.
 */
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
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

// ── Walk bounds ──
//
// glob is readOnly + concurrencySafe, so the executor runs N of them in one
// Promise.all batch; every bound below is PER CALL and multiplies by that N.
// Before these existed one wide pattern could exhaust the heap: depth and
// readdir fan-out were unbounded (a symlink cycle, or a link into a huge tree,
// walked until ELOOP with the error swallowed) and every match was collected
// and stat()ed before the 200-entry limit applied last. The Aug 30 OOM
// snapshot — 3.9GB heap, 126-206 pending FSReqCallbacks — was that fan-out.
//
// Symlinks ARE still followed. The packaged app bridges <cwd>/workspace to the
// configured workspace with a dir symlink / junction (workspace/lifecycle.ts
// ensureWorkspaceLink), and the default search root is that cwd — so a walk
// that skipped links would return "No files matched." for every user file.
// The depth and scan caps below are what bound a cycle, not link-skipping.

// Directories never worth walking. `**` matches any prefix, so
// `**/node_modules/**` already covers desktop/node_modules and every other
// nested install. `.claude/worktrees` needs its own entry: `dot:false` keeps a
// bare `**` out of `.claude`, but an explicit `.claude/**` pattern walks in,
// and this repo carries 150+ worktrees under it.
export const WALK_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/vendor/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/coverage/**",
  "**/.claude/worktrees/**",
];

// Nested directory levels ENTERED below the pattern's static base (files in a
// level-12 directory are listed; a level-13 directory is not opened). Real
// source trees bottom out around 8-10 (deep Java packages, nested monorepos),
// so 12 loses nothing while bounding a `**` that lands on an unignored
// generated tree or a symlink cycle. The model can re-root with `path`.
export const MAX_DEPTH = 12;

// Concurrent readdir()s per walk. fast-glob defaults to os.cpus().length —
// 16-32 on a dev box — per CALL, which is how a batch of globs piled up
// hundreds of pending fs callbacks.
export const WALK_CONCURRENCY = 8;

// Matches collected before the walk is cut off. 25x the 200-entry result
// limit: plenty for the mtime sort to surface the newest files of any sane
// tree, small enough that the path array stays in the low MBs however wide
// the pattern. Past it the result says so and asks for a narrower pattern
// instead of silently walking on.
export const MAX_SCAN = 5000;

interface Walk { paths: string[]; truncated: boolean }

/** fast-glob's pluggable filesystem — a test seam for counting readdir()s. */
export type WalkFs = NonNullable<fg.Options["fs"]>;

// Stream matches and destroy the walk at MAX_SCAN. fast-glob wires the
// returned stream's 'close' to the directory walker's destroy, so cutting it
// off here stops the readdir fan-out rather than merely ignoring it.
// Exported for the test that proves that (a virtual fs counts the readdirs).
export function walkBounded(pattern: string, cwd: string, fs?: WalkFs): Promise<Walk> {
  return new Promise((resolve, reject) => {
    const paths: string[] = [];
    let truncated = false;
    // fast-glob types its stream as NodeJS.ReadableStream, which has no
    // destroy(); the object it constructs is a node:stream Readable.
    const stream = fg.stream(pattern, {
      cwd,
      dot: false,
      onlyFiles: true,
      absolute: true,
      suppressErrors: true,
      followSymbolicLinks: true,
      // fast-glob's `deep` is exclusive — a directory AT that level is not
      // opened — so +1 makes MAX_DEPTH mean "levels entered".
      deep: MAX_DEPTH + 1,
      concurrency: WALK_CONCURRENCY,
      ignore: WALK_IGNORE,
      fs,
    }) as Readable;
    stream.on("data", (p: string) => {
      if (truncated) return;
      paths.push(p);
      if (paths.length >= MAX_SCAN) {
        truncated = true;
        stream.destroy();
        resolve({ paths, truncated });
      }
    });
    stream.once("end", () => resolve({ paths, truncated }));
    stream.on("error", reject);
  });
}

async function globFiles(pattern: string, cwd: string, limit: number): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const { paths, truncated } = await walkBounded(pattern, cwd);

  const entries: FileEntry[] = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      entries.push({ path: p, mtime: s.mtimeMs, size: s.size });
    } catch { /* skip inaccessible files */ }
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return { entries: entries.slice(0, limit), truncated };
}

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Fast file pattern matching. Returns files matching a glob pattern, sorted by modification time (newest first). " +
    "Supports patterns like **/*.ts, src/**/*.tsx, *.json. " +
    `Walks at most ${MAX_DEPTH} directory levels below the search root and stops after ${MAX_SCAN} matches — pass path to search deeper or narrower.`,
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
      const { entries, truncated } = await globFiles(pattern, cwd, 200);
      const durationMs = Date.now() - startMs;
      if (entries.length === 0) return ok("No files matched.", { pattern, cwd, count: 0, duration_ms: durationMs });

      const lines = entries.map((e) => `${e.path}  (${humanSize(e.size)})`);
      const warning = truncated
        ? `\nWARNING: the walk stopped after ${MAX_SCAN} matches — this list is the newest of THOSE, not of the whole tree; narrow the path or use a more specific pattern.`
        : "";
      return ok(lines.join("\n") + warning, {
        pattern,
        cwd,
        count: entries.length,
        capped: entries.length === 200 || undefined,
        scan_truncated: truncated || undefined,
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
    `The walk enters at most ${MAX_DEPTH} directory levels below the search root and stops after ${MAX_SCAN} matches (the result says so) — pass path to re-root deeper, or narrow the pattern.`,
    "Provide an optional path to search in a specific directory.",
  ].join("\n");
}
