/**
 * Structural Search Tool — symbol-accurate code search backed by language-intel.
 *
 * Finds real references/definitions of a NAMED symbol via the language service
 * (TS/JS today), immune to the comment/string/dynamic-import() false hits that
 * fool a regex scan. Languages without a provider fall back to a ripgrep
 * word-boundary search, clearly labeled so the model knows precision dropped.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import type { ReferenceHit } from "../language-intel/index.js";
import { getLanguageIntel } from "../language-intel/index.js";
import { ripgrepBin, searchRoot } from "./grep-tool.js";
import { ok, err } from "./result-helpers.js";

type Mode = "references" | "definition";

const DEFAULT_LIMIT = 50;
/** How many candidate positions to resolve the bare symbol name to before
 *  querying the language service from the best (declaration-first) one. */
const POSITION_PROBE_LIMIT = 5;

function truncate(lines: string[], limit: number): string {
  if (lines.length <= limit) return lines.join("\n");
  return lines.slice(0, limit).join("\n") + `\n... (${lines.length - limit} more)`;
}

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
function runWordFallback(symbol: string, root: string, limit: number, signal?: AbortSignal): Promise<ToolResult> {
  const rgArgs = ["-n", "--word-regexp", "--fixed-strings", "--no-heading", "--color", "never", symbol, root];
  return new Promise((resolve, reject) => {
    const child = execFile(ripgrepBin(), rgArgs, { maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout) => {
      if (signal?.aborted) return resolve(err("Aborted"));
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
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
      resolve(ok(`${header}\n${truncate(lines, limit)}`));
    });
    child.stdin?.end();
  });
}

// ── Tool definition ──

export const structuralSearchTool: ToolDefinition = {
  name: "structural_search",
  description:
    "Symbol-accurate code search. Finds real references/definitions of a named symbol using the language " +
    "service (TS/JS) — immune to false hits in comments, strings, and dynamic import() text that fool grep. " +
    "Falls back to word-boundary text search for other languages. Use for 'who calls X / where is X defined'; " +
    "use grep for free-text or pattern search.",
  readOnly: true,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Identifier to search for (function/class/variable/method name — a bare word, not a pattern)" },
      path:   { type: "string", description: "Root directory to search (defaults to the session work root)" },
      mode:   { type: "string", enum: ["references", "definition"], description: "Find all references (default) or the definition site" },
      limit:  { type: "number", description: "Max hits (default 50)" },
    },
    required: ["symbol"],
  },
  async execute(args, signal): Promise<ToolResult> {
    const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
    if (symbol === "") return err("symbol is required (a bare identifier, e.g. a function or class name)");
    const mode: Mode | null =
      args.mode === undefined || args.mode === "references" ? "references"
      : args.mode === "definition" ? "definition"
      : null;
    if (mode === null) return err(`Unknown mode "${String(args.mode)}" — use "references" or "definition".`);
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;

    const root = searchRoot(args);
    const rootStat = await stat(root).catch(() => null);
    if (rootStat === null || !rootStat.isDirectory()) {
      return err(`Search root is not a directory: ${root}. Pass 'path' as an existing directory to search under.`);
    }

    // Language-intel path: resolve the bare name to AST-true positions
    // (declarations first), then query the language service from the best one.
    const intel = getLanguageIntel();
    const positions = await intel.findSymbolPositions(root, symbol, { limit: POSITION_PROBE_LIMIT });
    if (positions.length > 0) {
      const origin = positions[0]; // declaration-first ordering (see language-intel facade)
      const hits = mode === "definition" ? await intel.findDefinition(origin) : await intel.findReferences(origin);
      if (hits.length === 0) {
        return ok(`No ${mode} for "${symbol}" found under ${root} (language service, TS/JS).`);
      }
      const lines = formatHits(hits, root);
      const header = `structural_search ${mode} of "${symbol}" under ${root} — ${lines.length} hit(s):`;
      return ok(`${header}\n${truncate(lines, limit)}`);
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
