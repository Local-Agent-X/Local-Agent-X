/**
 * How far a change to one declaration reaches, symbol by symbol: hop 1 is
 * every top-level declaration that uses it, hop 2 every one that uses a hop-1
 * declaration, and so on. Each hop's uses come from the compiler's own
 * find-references, so a renamed import or a barrel re-export is followed where
 * a text search stops. Test files are where the reach ends: they are the tests
 * to run, never followed further.
 *
 * One implementation for the agent's `structural_search` tool and the
 * `npm run refs -- --depth` command (scripts/refs.ts). In the server the walk
 * shares the event loop with every chat, so it yields between targets and
 * stops at a deadline as well as at a declaration cap.
 */
import { readFileSync, statSync } from "node:fs";
import ts from "typescript";
import type { ReferenceHit, SymbolLocation } from "./types.js";

export interface ReachedDeclaration extends SymbolLocation {
  name: string;
}

export interface Reach {
  /** Declarations reached at each hop, hop 1 first. */
  hops: ReachedDeclaration[][];
  /** Uses at module scope (a registration call, a default export): the file is reached, nothing to follow. */
  moduleScope: Array<{ file: string; line: number }>;
  /** Test files that use a reached declaration. */
  tests: string[];
  /** True when the walk stopped at the declaration cap or the deadline before reaching `depth`. */
  capped: boolean;
}

export interface ReachLimits {
  /** Stop once this many declarations are reached (default 300). */
  declarations?: number;
  /** Stop once the walk has run this long, in ms (default: no deadline). */
  deadlineMs?: number;
}

const DEFAULT_DECLARATION_CAP = 300;

/** An import or re-export line, including one name alone on a line inside a
 *  multi-line `import { … }` / `export { … } from` block. */
export const IMPORT_LINE = /^\s*(import\b|export\s*(\*|\{|type\s*\{)|\}\s*from\s|(type\s+)?[A-Za-z_$][\w$]*(\s+as\s+[A-Za-z_$][\w$]*)?,?\s*$)/;

// Parsed files the walk has looked inside, newest last. Bounded and checked
// against the file's mtime: the server holds this for as long as it runs, and
// the agent edits these files between queries.
const MAX_PARSED = 256;
const parsed = new Map<string, { mtimeMs: number; source: ts.SourceFile }>();

function sourceOf(file: string): ts.SourceFile {
  const mtimeMs = statSync(file).mtimeMs;
  const held = parsed.get(file);
  if (held && held.mtimeMs === mtimeMs) return held.source;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  parsed.delete(file);
  parsed.set(file, { mtimeMs, source });
  if (parsed.size > MAX_PARSED) parsed.delete(parsed.keys().next().value as string);
  return source;
}

/** Drop the parsed files (language-intel's dispose). */
export function clearReachSources(): void {
  parsed.clear();
}

/** The top-level declaration whose text holds `line` of `file`, by its name's
 *  position; null when the line is at module scope outside any named one. */
export function enclosingDeclaration(file: string, line: number): ReachedDeclaration | null {
  const sf = sourceOf(file);
  const pos = sf.getPositionOfLineAndCharacter(Math.max(0, line - 1), 0);
  const at = (name: ts.Identifier): ReachedDeclaration => {
    const lc = sf.getLineAndCharacterOfPosition(name.getStart(sf));
    return { file, line: lc.line + 1, column: lc.character + 1, name: name.text };
  };
  const holds = (n: ts.Node) => n.getFullStart() <= pos && pos < n.getEnd();
  for (const st of sf.statements) {
    if (!holds(st)) continue;
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)
      || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) return at(st.name);
    if (ts.isVariableStatement(st)) {
      const decls = st.declarationList.declarations;
      const d = decls.find(holds) ?? decls[0];
      return d && ts.isIdentifier(d.name) ? at(d.name) : null;
    }
    return null;
  }
  return null;
}

const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Walk the uses of `start` out to `depth` hops. */
export async function symbolReach(
  findReferences: (loc: SymbolLocation) => Promise<ReferenceHit[]>,
  start: SymbolLocation,
  depth: number,
  isTest: (file: string) => boolean,
  limits: ReachLimits = {},
): Promise<Reach> {
  const cap = limits.declarations ?? DEFAULT_DECLARATION_CAP;
  const deadline = limits.deadlineMs === undefined ? Infinity : Date.now() + limits.deadlineMs;
  const key = (l: { file: string; line: number }) => `${l.file}:${l.line}`;
  const seen = new Set([key(start)]);
  const reach: Reach = { hops: [], moduleScope: [], tests: [], capped: false };
  const tests = new Set<string>();
  const moduleSeen = new Set<string>();
  let frontier: SymbolLocation[] = [start];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next: ReachedDeclaration[] = [];
    let outOfTime = false;
    for (const target of frontier) {
      if (Date.now() > deadline) { outOfTime = true; break; }
      for (const hit of await findReferences(target)) {
        if (hit.isDefinition || IMPORT_LINE.test(hit.lineText)) continue;
        if (isTest(hit.file)) { tests.add(hit.file); continue; }
        const decl = enclosingDeclaration(hit.file, hit.line);
        if (!decl) {
          if (!moduleSeen.has(key(hit))) { moduleSeen.add(key(hit)); reach.moduleScope.push({ file: hit.file, line: hit.line }); }
          continue;
        }
        if (seen.has(key(decl))) continue;
        seen.add(key(decl));
        next.push(decl);
      }
      await breathe();
    }
    reach.hops.push(next);
    if (outOfTime) { reach.capped = true; break; }
    if (seen.size > cap) { reach.capped = hop < depth; break; }
    frontier = next;
  }
  reach.tests = [...tests].sort();
  return reach;
}
