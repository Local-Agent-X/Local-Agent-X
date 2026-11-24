/**
 * The three ways a caller names a symbol, read in one place for the agent's
 * `structural_search` tool and the `npm run refs` command:
 *
 *   <Name>                 every module-level declaration named <Name> under the root
 *   <file>#<Name>          only the declaration in <file>
 *   <file>:<line>[:col]    the symbol at a position (a member, a local)
 *
 * A bare name cannot reach a method or a local: two classes may each have a
 * `save`, and neither is a module-level declaration. The position form can.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SymbolLocation } from "./types.js";

const POSITION = /^(.+?):(\d+)(?::(\d+))?$/;

/** The file a query names, resolved against `base`; null for a bare name. A
 *  caller that confines what it reads checks this before resolving the query. */
export function symbolQueryFile(query: string, base: string): string | null {
  if (query.includes("#")) return resolve(base, query.slice(0, query.indexOf("#")));
  const position = POSITION.exec(query);
  return position ? resolve(base, position[1]) : null;
}

export interface SymbolQueryOptions {
  /** What a relative <file> is relative to (default: the root). */
  base?: string;
  /** How many same-named declarations to consider (default 200). */
  limit?: number;
}

/**
 * The declarations (or the one position) a query names. Empty when nothing by
 * that name is declared at module level under `root`, or the named file cannot
 * be read.
 */
export async function symbolTargets(
  findSymbolPositions: (root: string, name: string, opts?: { limit?: number }) => Promise<SymbolLocation[]>,
  root: string,
  query: string,
  options: SymbolQueryOptions = {},
): Promise<SymbolLocation[]> {
  const base = options.base ?? root;
  const position = query.includes("#") ? null : POSITION.exec(query);
  if (position) {
    const file = resolve(base, position[1]);
    const line = Number(position[2]);
    let text: string;
    try { text = readFileSync(file, "utf8").split(/\r?\n/)[line - 1] ?? ""; } catch { return []; /* no such file: nothing is named */ }
    const column = position[3] ? Number(position[3]) : (text.search(/[A-Za-z_$]/) + 1 || 1);
    return [{ file, line, column }];
  }
  const cut = query.indexOf("#");
  const file = cut >= 0 ? resolve(base, query.slice(0, cut)) : null;
  const name = cut >= 0 ? query.slice(cut + 1) : query;
  const found = await findSymbolPositions(root, name, { limit: options.limit ?? 200 });
  return found.filter((p) => p.kind === "declaration" && p.topLevel && (!file || resolve(p.file) === file));
}
