/**
 * Structural Search Tool — symbol-accurate code search backed by language-intel.
 *
 * Finds real references/definitions of a NAMED symbol via the language service
 * (TS/JS today), immune to the comment/string/dynamic-import() false hits that
 * fool a regex scan. Languages without a provider fall back to a ripgrep
 * word-boundary search, clearly labeled so the model knows precision dropped.
 *
 * Mode "reach" answers what a change to the symbol touches: the declarations
 * that use it, those that use them, and the test files to run
 * (language-intel/reach.ts, the same walk `npm run refs -- --depth` prints).
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import type { LanguageIntel, Reach, ReferenceHit, SymbolLocation } from "../language-intel/index.js";
import { getLanguageIntel, symbolQueryFile } from "../language-intel/index.js";
import { isTestFile } from "../agent-guards/build-command.js";
import { ripgrepBin, searchRoot } from "./grep-tool.js";
import { ok, err } from "./result-helpers.js";
import { truncate } from "./grep-context.js";

type Mode = "references" | "definition" | "reach";

const DEFAULT_LIMIT = 50;
/** How many candidate positions to resolve the bare symbol name to before
 *  querying the language service from the best (declaration-first) one. */
const POSITION_PROBE_LIMIT = 5;
/** Reach is a walk of find-references calls on the server's own thread: a few
 *  hops answer "what does this change touch", and the walk stops at a deadline. */
const MAX_REACH_DEPTH = 3;
const REACH_DEADLINE_MS = 8_000;

/** Dedupe hits by file:line and format as `file:line:  lineText` (path
 *  relative to root), definition sites prefixed `[def]`. */
function formatHits(hits: ReferenceHit[], root: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const hit of hits) {
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = relative(root, hit.file) || hit.file;
    lines.push(`${hit.isDefinition ? "[def] " : ""}${rel}:${hit.line}:  ${hit.lineText.trim()}`);
  }
  return lines;
}

// ── ripgrep word-boundary fallback (unsupported languages) ──
// Same spawn shape as grep-tool's runRg; --fixed-strings because `symbol` is
// a bare identifier, never a pattern. Rejects on ENOENT so the caller can
// produce an actionable "rg missing" error.

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

/** Exported for tests — the tool routes non-TS/JS roots through this. */
export function runWordFallback(
  symbol: string,
  root: string,
  limit: number,
  signal?: AbortSignal,
  exec: ExecFileLike = defaultExec,
): Promise<ToolResult> {
  // `--` ends option parsing so a symbol beginning with a dash (`-e`, `--pre`)
  // is matched literally instead of being consumed as an rg flag.
  const rgArgs = ["-n", "--word-regexp", "--fixed-strings", "--no-heading", "--color", "never", "--", symbol, root];
  return new Promise((resolve, reject) => {
    const child = exec(ripgrepBin(), rgArgs, { maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (signal?.aborted) return resolve(err("Aborted"));
      // Error discrimination (rg's documented exit codes): 1 = no matches
      // (not a failure); ENOENT = rg not installed (reject → actionable
      // message upstream); maxBuffer overflow = usable-but-truncated output;
      // anything else (exit 2 = real failure, other errnos) is a real error —
      // never round it down to "No matches".
      const code = error?.code;
      const truncated = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      if (error && code === "ENOENT") return reject(error);
      if (error && code !== 1 && !truncated) {
        const snippet = (stderr || "").trim().split("\n")[0]?.slice(0, 300) ?? "";
        return resolve(err(
          `structural_search text fallback failed: ripgrep exited with ${String(code ?? error.message)}` +
          (snippet ? ` — ${snippet}` : ""),
        ));
      }
      const out = (stdout || "").trim();
      // rg exits 1 on no matches — an empty result, not an error.
      if (!out) {
        return resolve(ok(`No matches for "${symbol}" under ${root} — text fallback (word-boundary).`));
      }
      const lines = out.split("\n").map((line) => {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (m === null) return line;
        return `${relative(root, m[1]) || m[1]}:${m[2]}:  ${m[3].trim()}`;
      });
      const header = `structural_search "${symbol}" under ${root} — text fallback (word-boundary), ${lines.length} hit(s):`;
      const warning = truncated
        ? `\nWARNING: output exceeded the buffer cap — this list is TRUNCATED; narrow the path or use a more specific symbol.`
        : "";
      resolve(ok(`${header}\n${truncate(lines, limit)}${warning}`));
    });
    child.stdin?.end();
  });
}

// ── Naming the symbol ──

type Origin = { at: SymbolLocation; note: string } | { error: string } | null;

const relTo = (root: string, p: { file: string; line: number }): string => `${relative(root, p.file) || p.file}:${p.line}`;

/**
 * The position the language service is asked from. A bare name is resolved
 * to its best declaration (module-level first), saying so when it had to
 * choose; `<file>#<Name>` and `<file>:<line>` name it outright. The named file
 * must sit under the search root: the root is what the caller was allowed to
 * read, and a path inside `symbol` is not judged by anything else.
 */
async function resolveOrigin(intel: LanguageIntel, root: string, symbol: string): Promise<Origin> {
  const named = symbolQueryFile(symbol, root);
  if (named !== null) {
    const inside = relative(root, named);
    if (inside.startsWith("..") || isAbsolute(inside)) return { error: `"${symbol}" names a file outside the search root ${root}. Pass 'path' as a directory that holds it.` };
    const targets = await intel.symbolTargets(root, symbol);
    return targets.length > 0
      ? { at: targets[0], note: "" }
      : { error: `Nothing found for "${symbol}" under ${root}: no such file, or no module-level declaration of that name in it. For a method or a local, pass <file>:<line> of its declaration.` };
  }
  const positions = await intel.findSymbolPositions(root, symbol, { limit: POSITION_PROBE_LIMIT });
  if (positions.length === 0) return null;
  // Declaration-first, module-level-first ordering (see ts-provider).
  const origin = positions[0];
  // Same-name ambiguity disclosure: the anchor is a CHOICE among the
  // candidate declarations, so say so instead of silently picking one.
  const declarations = positions.filter((p) => p.kind === "declaration");
  if (declarations.length <= 1 || origin !== declarations[0]) return { at: origin, note: "" };
  const others = declarations.slice(1, 5).map((p) => relTo(root, p)).join(", ");
  return {
    at: origin,
    note:
      `\nnote: ${declarations.length} same-named declarations found; anchored on ${relTo(root, origin)} — ` +
      `pass a narrower path, or <file>#${symbol}, to disambiguate (others: ${others})`,
  };
}

// ── Reach ──

/** Where a reach walk ends: a test file, or anything in a tests folder. */
function endsReach(file: string): boolean {
  return isTestFile(file) || /[\\/](__tests__|tests?)[\\/]/.test(file);
}

function formatReach(reach: Reach, origin: SymbolLocation, symbol: string, root: string, depth: number, limit: number): string {
  const out: string[] = [`structural_search reach of "${symbol}" (${relTo(root, origin)}) under ${root} — depth ${depth}:`];
  reach.hops.forEach((declarations, i) => {
    const byFile = new Map<string, string[]>();
    for (const d of declarations) byFile.set(d.file, [...(byFile.get(d.file) ?? []), `${d.name}:${d.line}`]);
    out.push(`hop ${i + 1}: ${declarations.length} declaration(s) in ${byFile.size} file(s)`);
    const lines = [...byFile].sort((a, b) => a[0].localeCompare(b[0])).map(([file, names]) => `  ${relative(root, file) || file}  ${names.join(", ")}`);
    if (lines.length > 0) out.push(truncate(lines, limit));
  });
  if (reach.moduleScope.length > 0) {
    out.push("used at module scope (the file is reached; nothing further to follow):");
    out.push(truncate(reach.moduleScope.map((m) => `  ${relTo(root, m)}`), limit));
  }
  if (reach.capped) out.push("(stopped early: too many declarations, or out of time. Lower depth or name a narrower symbol; what is listed is real but not all of it.)");
  out.push(`tests to run (${reach.tests.length}): the test files that use a reached declaration`);
  if (reach.tests.length > 0) out.push(truncate(reach.tests.map((t) => `  ${relative(root, t) || t}`), limit));
  return out.join("\n");
}

// ── Tool definition ──

export const structuralSearchTool: ToolDefinition = {
  name: "structural_search",
  description:
    "Symbol-accurate code search. Finds real references/definitions of a named symbol using the language " +
    "service (TS/JS) — immune to false hits in comments, strings, and dynamic import() text that fool grep. " +
    "Falls back to word-boundary text search for other languages. Use for 'who calls X / where is X defined'; " +
    "mode 'reach' before changing something shared: what the change reaches, hop by hop, and the tests to run. " +
    "Use grep for free-text or pattern search.",
  readOnly: true,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "The symbol: a bare identifier (function/class/variable name, not a pattern); <file>#<Name> for the declaration in one file; or <file>:<line> for the symbol on a line (a method, a member, a local), file relative to the search root" },
      path:   { type: "string", description: "Root directory to search (defaults to the session work root)" },
      mode:   { type: "string", enum: ["references", "definition", "reach"], description: "All references (default), the definition site, or reach: the declarations that use it, those that use them, and the test files to run (TS/JS only)" },
      depth:  { type: "number", description: `reach only: how many hops out to follow (default 1, at most ${MAX_REACH_DEPTH})` },
      limit:  { type: "number", description: "Max hits (default 50)" },
    },
    required: ["symbol"],
  },
  async execute(args, signal): Promise<ToolResult> {
    const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
    if (symbol === "") return err("symbol is required (a bare identifier, e.g. a function or class name)");
    const mode: Mode | null =
      args.mode === undefined || args.mode === "references" ? "references"
      : args.mode === "definition" || args.mode === "reach" ? args.mode
      : null;
    if (mode === null) return err(`Unknown mode "${String(args.mode)}" — use "references", "definition" or "reach".`);
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
    const depth = typeof args.depth === "number" && args.depth >= 1 ? Math.min(MAX_REACH_DEPTH, Math.floor(args.depth)) : 1;

    const root = searchRoot(args);
    const rootStat = await stat(root).catch(() => null);
    if (rootStat === null || !rootStat.isDirectory()) {
      return err(`Search root is not a directory: ${root}. Pass 'path' as an existing directory to search under.`);
    }

    // Language-intel path: resolve the symbol to an AST-true position, then
    // query the language service from it.
    const intel = getLanguageIntel();
    const origin = await resolveOrigin(intel, root, symbol);
    if (origin !== null && "error" in origin) return err(origin.error);
    if (origin !== null) {
      if (mode === "reach") {
        const reach = await intel.reach(origin.at, depth, endsReach, { deadlineMs: REACH_DEADLINE_MS });
        return ok(formatReach(reach, origin.at, symbol, root, depth, limit) + origin.note);
      }
      const hits = mode === "definition" ? await intel.findDefinition(origin.at) : await intel.findReferences(origin.at);
      if (hits.length === 0) {
        return ok(`No ${mode} for "${symbol}" found under ${root} (language service, TS/JS).${origin.note}`);
      }
      const lines = formatHits(hits, root);
      const header = `structural_search ${mode} of "${symbol}" under ${root} — ${lines.length} hit(s):${origin.note}`;
      return ok(`${header}\n${truncate(lines, limit)}`);
    }
    if (mode === "reach") {
      return err(`structural_search reach found no TS/JS symbol "${symbol}" under ${root}. Reach needs the language service; for other languages use mode "references" (text search).`);
    }

    // No symbol positions (non-TS/JS root, or the name simply isn't there):
    // word-boundary text fallback.
    try {
      return await runWordFallback(symbol, root, limit, signal);
    } catch (e) {
      return err(
        `structural_search found no TS/JS symbol "${symbol}" under ${root}, and the ripgrep text fallback is ` +
        `unavailable (${(e as Error).message}). Install ripgrep (rg) or use the grep tool instead.`,
      );
    }
  },
};
