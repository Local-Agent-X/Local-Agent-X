/**
 * Glob Tool -- file pattern matching for agents.
 * Replaces bash find/ls with structured glob results sorted by mtime.
 */
import { existsSync, readdir as nodeReaddir } from "node:fs";
import { stat } from "node:fs/promises";
import { suggestElsewhere } from "./edit-recovery.js";
import { resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import fg from "fast-glob";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { resolveAgentPath, sessionIdOf, stripWorkspacePrefix } from "../workspace/paths.js";

// Resolve the search base through the canonical agent-path resolver — the SAME
// one read/grep and the security gate use — so a "~/..." or workspace-relative
// base expands once, identically to how it's gated, instead of being joined
// onto a raw cwd and failing until the model retries. Absent path → "." through
// that same resolver, which is ONE rule for every tool: the session's work
// root when one is registered (a chunk worker's bare glob("**/*.ts") must
// search its project), else the workspace — the same anchor read/write/bash
// resolve relative paths against. It used to fall back to process.cwd(), which in
// the dev server is the git checkout: a model's first bare glob searched the
// wrong tree and returned nothing (session chat-mtrxppqw-m7fah, 2026-09-08).
// Exported for direct testing (guards against a regression back to cwd).
export function searchBase(rawPath: unknown, sessionId?: string): string {
  const p = rawPath != null && String(rawPath) !== "" ? String(rawPath) : ".";
  return resolveAgentPath(p, sessionId);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

interface FileEntry { path: string; mtime: number; size: number; dir: boolean }

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
// Symlinks ARE still followed. The default search root is the workspace (via
// resolveAgentPath — see searchBase), and the packaged app also bridges
// <cwd>/workspace to it with a dir symlink / junction
// (workspace/lifecycle.ts ensureWorkspaceLink); user
// files routinely sit behind such links, so a walk that skipped them would
// return "No files matched." for every one of them. The depth and scan caps
// below are what bound a cycle, not link-skipping.

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

// Directories opened before the walk is cut off, however few matches it has.
// MAX_SCAN bounds matches, not breadth: `**/two_bucket*` from C:\ matched one
// file after opening the whole drive, 19.5s of walking (muse, 2026-09-17).
export const MAX_DIRS = 20_000;

/** Why a walk stopped early: too many matches, or too many directories opened. */
export type WalkCut = "matches" | "breadth";

interface Walk { paths: string[]; truncated: boolean; cut?: WalkCut }

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
    let dirs = 0;
    const stop = (cut: WalkCut) => {
      if (truncated) return;
      truncated = true;
      stream.destroy();
      resolve({ paths, truncated, cut });
    };
    // Every directory's entries are matched in one synchronous run, and the
    // walker chains those runs through promises, so timers never fire in
    // between: that walk of C:\ blocked the event loop for 11s. Handing each
    // readdir result back on setImmediate gives the loop a turn per directory.
    const readdirImpl = (fs?.readdir ?? nodeReaddir) as (...a: unknown[]) => void;
    const readdir = (...args: unknown[]) => {
      const cb = args.pop() as (...r: unknown[]) => void;
      if (++dirs > MAX_DIRS) {
        stop("breadth");
        return setImmediate(cb, null, []);
      }
      readdirImpl(...args, (...r: unknown[]) => setImmediate(cb, ...r));
    };
    // fast-glob types its stream as NodeJS.ReadableStream, which has no
    // destroy(); the object it constructs is a node:stream Readable.
    const stream = fg.stream(pattern, {
      cwd,
      dot: false,
      // Directories match too. "Find my CRM project" is a search for a FOLDER
      // named like crm, and with files only `**/*crm*` can never return
      // `projects/clients/2025/jobs-crm-app/` — it returned the one stray
      // notes file instead and the model reported that as the project
      // (op-outcomes find-project, 2026-09-22). A directory renders with a
      // trailing separator so the model can tell it from a file.
      onlyFiles: false,
      // Match case the way the filesystem does. Windows and macOS resolve
      // `CRM/` and `crm/` to the same folder, so a pattern that names one
      // must find the other — `**/CRM*` returned nothing for a `crm` project
      // on Windows (op-outcomes find-project, 2026-09-22). Linux keeps exact
      // case, as its filesystem does.
      caseSensitiveMatch: process.platform === "linux",
      absolute: true,
      suppressErrors: true,
      followSymbolicLinks: true,
      // fast-glob's `deep` is exclusive — a directory AT that level is not
      // opened — so +1 makes MAX_DEPTH mean "levels entered".
      deep: MAX_DEPTH + 1,
      concurrency: WALK_CONCURRENCY,
      ignore: WALK_IGNORE,
      fs: { ...fs, readdir: readdir as unknown as typeof nodeReaddir },
    }) as Readable;
    stream.on("data", (p: string) => {
      if (truncated) return;
      paths.push(p);
      if (paths.length >= MAX_SCAN) stop("matches");
    });
    stream.once("end", () => resolve({ paths, truncated }));
    stream.on("error", reject);
  });
}

async function globFiles(pattern: string, cwd: string, limit: number): Promise<{ entries: FileEntry[]; truncated: boolean; cut?: WalkCut }> {
  const { paths, truncated, cut } = await walkBounded(pattern, cwd);

  const entries: FileEntry[] = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      // fast-glob always yields POSIX separators, so on Windows the walk
      // returned "C:/Users/..." while `cwd` in this same result — and every
      // path `read`, `grep` and the security gate emit — is the canonical
      // "C:\Users\...". One result carried two spellings and glob was the
      // only tool speaking the second. resolve() is what resolveAgentPath
      // itself applies to an absolute path, so this re-enters the canonical
      // form and is a no-op off Windows.
      entries.push({ path: resolve(p), mtime: s.mtimeMs, size: s.size, dir: s.isDirectory() });
    } catch { /* skip inaccessible files */ }
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return { entries: entries.slice(0, limit), truncated, cut };
}

/**
 * Zero matches for an anchored pattern is usually the pattern, not the tree:
 * `*.tmp` under cleanup/ matches only the top level while the files sit in
 * cleanup/build/ and cleanup/cache/, and the model reported the folder
 * "already clean" (op-outcomes constraint-survives-long-session, 2026-09-25,
 * two of three runs). Try the recursive and the substring forms once, bounded,
 * and say what they would have matched. Silent when they match nothing too.
 */
export async function noMatchHint(pattern: string, cwd: string): Promise<string> {
  const base = pattern.split("/").pop() ?? pattern;
  const core = base.replace(/^\*+/, "").replace(/\*+$/, "");
  const alts: { alt: string; why: string }[] = [];
  if (!pattern.includes("/")) alts.push({ alt: `**/${pattern}`, why: "a pattern without **/ matches only the top level of the search path" });
  if (core && core !== base && !/[*?[\]{}]/.test(core)) alts.push({ alt: `**/*${core}*`, why: "a pattern is anchored at the start of the name; * on both sides matches a substring" });
  // The same anchoring in a MIDDLE segment: `**/crm*/**` is "folders whose name
  // starts with crm", and misses jobs-crm-app (op-outcomes find-project, 0/3
  // at 6fdbcaee — the last-segment rule above could not see it).
  const segs = pattern.split("/");
  const mid = segs.findIndex((s, i) => i < segs.length - 1 && s !== "**" && /[*?]/.test(s) && !s.startsWith("*"));
  if (mid >= 0) {
    const midCore = segs[mid].replace(/\*+$/, "");
    if (midCore && !/[*?[\]{}]/.test(midCore)) {
      alts.push({ alt: [...segs.slice(0, mid), `*${midCore}*`, ...segs.slice(mid + 1)].join("/"), why: "a folder-name pattern is anchored at the start of the name; * on both sides matches a substring" });
    }
  }
  for (const { alt, why } of alts) {
    if (alt === pattern) continue;
    try {
      const { paths, truncated } = await walkBounded(alt, cwd);
      if (paths.length) return `\n\`${alt}\` matches ${paths.length}${truncated ? "+" : ""} under ${cwd} — ${why}.`;
    } catch { /* the hint is best-effort */ }
  }
  return "";
}

export const globTool: ToolDefinition = {
  name: "glob",
  compactDescription: `Fast file pattern matching (e.g. src/**/*.tsx), newest first, from your workspace by default. Walks at most ${MAX_DEPTH} levels and stops after ${MAX_SCAN} matches (a bare **/* truncates) — pass a path to narrow the search.`,
  description:
    "Fast file pattern matching. Returns files AND folders matching a glob pattern, sorted by modification time (newest first); a folder is listed with a trailing separator. " +
    "Supports patterns like **/*.ts, src/**/*.tsx, *.json, and **/*crm* to find a project folder by name. " +
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
        description: "Directory to search in. Defaults to the workspace (the same root relative paths in read/bash resolve against).",
      },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = String(args.pattern ?? "");
    if (!raw) return err("pattern is required");
    // A pattern is matched against the base, never resolved as a path, so it
    // needs the same leading-"workspace/" strip resolveAgentPath applies —
    // otherwise the prefixed form the prompt teaches doubles the segment and
    // matches nothing.
    const pattern = stripWorkspacePrefix(raw);

    const cwd = searchBase(args.path, sessionIdOf(args));
    const startMs = Date.now();

    // A search rooted at a folder the model guessed (`workspace/apps/<name>`
    // for a project that sits at the workspace root) used to say "No files
    // matched" and the model concluded the project did not exist and created
    // one (op-outcomes correction-chain, 2026-09-25). Say the root is missing,
    // and where a folder of that name really is.
    if (!existsSync(cwd)) {
      const elsewhere = suggestElsewhere(cwd);
      const hint = elsewhere.length
        ? `\nA folder with that name exists elsewhere in the workspace: ${elsewhere.join(", ")} — a path is relative to the workspace root; do not assume a project sits under apps/.`
        : "";
      return ok(`No files matched — the search path does not exist: ${cwd}${hint}`, { pattern, cwd, count: 0, duration_ms: Date.now() - startMs });
    }

    try {
      const { entries, truncated, cut } = await globFiles(pattern, cwd, 200);
      const durationMs = Date.now() - startMs;
      const warning = cut === "breadth"
        ? `\nWARNING: the walk stopped after opening ${MAX_DIRS} directories — ${cwd} is too broad to search, so files in the part it never reached are not listed. Pass a narrower path.`
        : truncated
          ? `\nWARNING: the walk stopped after ${MAX_SCAN} matches — this list is the newest of THOSE, not of the whole tree; narrow the path or use a more specific pattern.`
          : "";
      if (entries.length === 0) {
        const hint = truncated ? "" : await noMatchHint(pattern, cwd);
        return ok(`No files matched.${hint}${warning}`, { pattern, cwd, count: 0, scan_truncated: truncated || undefined, duration_ms: Date.now() - startMs });
      }

      const lines = entries.map((e) => (e.dir ? `${e.path}${sep}  (dir)` : `${e.path}  (${humanSize(e.size)})`));
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
    "Supports patterns like **/*.ts, src/**/*.tsx, *.json. Folders match too (listed with a trailing separator), so **/*crm* finds a project folder named like crm.",
    "Results are sorted by modification time (newest first), limited to 200.",
    `The walk enters at most ${MAX_DEPTH} directory levels below the search root, opens at most ${MAX_DIRS} directories, and stops after ${MAX_SCAN} matches (the result says so) — pass path to re-root deeper, or narrow the pattern.`,
    "Provide an optional path to search in a specific directory.",
  ].join("\n");
}
