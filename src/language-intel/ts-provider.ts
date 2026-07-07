// LanguageIntelProvider for TypeScript/JavaScript, backed by the per-project
// LanguageService cache in ts-project.ts.
//
// Query contract (spec): invalid input — a file outside any project, a
// position past EOF, an unparseable line — answers with [] rather than a
// throw; callers treat empty as "no intelligence available" and fall back.

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import type { FileDiagnostic, LanguageIntelProvider, ReferenceHit, SymbolLocation } from "./types.js";
import { TsProject, disposeAllProjects, getProjectForFile } from "./ts-project.js";

const SUPPORTED_RE = /\.(ts|tsx|js|jsx|mts|cts)$/i;
const DECLARATION_FILE_RE = /\.d\.(ts|mts|cts)$/i;
/** findSymbolPositions skips files above this size — a bundle or generated
 *  blob, not something worth an AST walk. */
const MAX_SCAN_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_SYMBOL_LIMIT = 20;

/** A validated query: the project answering it, the source file as the
 *  program sees it, and the clamped character offset for the position. */
interface Query {
  project: TsProject;
  file: string;
  sourceFile: ts.SourceFile;
  position: number;
}

function prepareQuery(loc: SymbolLocation): Query | null {
  const file = resolve(loc.file);
  const project = getProjectForFile(file);
  if (!project.ensureFile(file)) return null;
  project.refresh();
  const sourceFile = project.service.getProgram()?.getSourceFile(file);
  if (sourceFile === undefined) return null;
  return { project, file, sourceFile, position: clampedOffset(sourceFile, loc.line, loc.column) };
}

/** 1-based line/column → character offset, clamped into the file (the inverse
 *  of getLineAndCharacterOfPosition, without its out-of-range throw). */
function clampedOffset(sf: ts.SourceFile, line: number, column: number): number {
  const starts = sf.getLineStarts();
  const lineIdx = Math.min(Math.max(0, line - 1), starts.length - 1);
  const lineStart = starts[lineIdx];
  const lineEnd = lineIdx + 1 < starts.length ? starts[lineIdx + 1] - 1 : sf.text.length;
  return lineStart + Math.min(Math.max(0, column - 1), Math.max(0, lineEnd - lineStart));
}

/** The full text of a 0-based line, without its line terminator. */
function lineTextAt(sf: ts.SourceFile, lineIdx: number): string {
  const starts = sf.getLineStarts();
  const start = starts[lineIdx];
  const end = lineIdx + 1 < starts.length ? starts[lineIdx + 1] : sf.text.length;
  return sf.text.slice(start, end).replace(/\r?\n$/, "");
}

/** Map one compiler hit to a ReferenceHit; null for node_modules/.d.ts hits
 *  (implementation surface, not the caller's code) or unknown files. */
function toHit(project: TsProject, fileName: string, start: number, isDefinition: boolean): ReferenceHit | null {
  if (fileName.includes("node_modules") || DECLARATION_FILE_RE.test(fileName)) return null;
  const sf = project.service.getProgram()?.getSourceFile(fileName);
  if (sf === undefined) return null;
  const { line, character } = sf.getLineAndCharacterOfPosition(start);
  return {
    file: sf.fileName,
    line: line + 1,
    column: character + 1,
    lineText: lineTextAt(sf, line),
    isDefinition,
  };
}

function toDiagnostic(file: string, d: ts.Diagnostic): FileDiagnostic | null {
  const severity =
    d.category === ts.DiagnosticCategory.Error ? "error" :
    d.category === ts.DiagnosticCategory.Warning ? "warning" : null;
  if (severity === null) return null; // suggestions/messages are editor noise, not diagnostics
  let line = 1;
  let column = 1;
  if (d.file !== undefined && d.start !== undefined) {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    line = pos.line + 1;
    column = pos.character + 1;
  }
  return { file, line, column, message: ts.flattenDiagnosticMessageText(d.messageText, "\n"), code: d.code, severity };
}

// ── findSymbolPositions: syntactic AST scan (no type-check needed) ──

/** Is this identifier the NAME of a declaration (not a use)? */
function isDeclarationName(node: ts.Identifier): boolean {
  const p = node.parent;
  return (
    (ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isEnumMember(p) ||
      ts.isVariableDeclaration(p) || ts.isParameter(p) ||
      ts.isMethodDeclaration(p) || ts.isMethodSignature(p) ||
      ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)) &&
    p.name === node
  );
}

/** Yield supported source files under `dir` (sorted for determinism),
 *  skipping node_modules, dot-directories, .d.ts, and oversized files.
 *  Unreadable directories are skipped by design — a permission hole in one
 *  subtree must not fail the whole scan. */
function* walkScriptFiles(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      yield* walkScriptFiles(full);
    } else if (SUPPORTED_RE.test(name) && !DECLARATION_FILE_RE.test(name) && st.size <= MAX_SCAN_BYTES) {
      yield full;
    }
  }
}

function collectSymbolHits(
  file: string,
  symbolName: string,
  declarations: SymbolLocation[],
  occurrences: SymbolLocation[],
  limit: number,
): void {
  const text = ts.sys.readFile(file);
  if (text === undefined) return;
  // A pure parse — comments and string contents never become Identifier
  // nodes, which is what makes this regex-false-positive-proof.
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === symbolName) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const hit: SymbolLocation = { file, line: line + 1, column: character + 1 };
      if (isDeclarationName(node)) {
        if (declarations.length < limit) declarations.push(hit);
      } else if (occurrences.length < limit) {
        occurrences.push(hit);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

export class TsLanguageIntelProvider implements LanguageIntelProvider {
  supports(file: string): boolean {
    return SUPPORTED_RE.test(file);
  }

  async findReferences(loc: SymbolLocation): Promise<ReferenceHit[]> {
    const q = prepareQuery(loc);
    if (q === null) return [];
    const symbols = q.project.service.findReferences(q.file, q.position);
    if (symbols === undefined) return [];
    const hits: ReferenceHit[] = [];
    for (const symbol of symbols) {
      for (const ref of symbol.references) {
        const hit = toHit(q.project, ref.fileName, ref.textSpan.start, ref.isDefinition === true);
        if (hit !== null) hits.push(hit);
      }
    }
    return hits;
  }

  async findDefinition(loc: SymbolLocation): Promise<ReferenceHit[]> {
    const q = prepareQuery(loc);
    if (q === null) return [];
    const defs = q.project.service.getDefinitionAtPosition(q.file, q.position) ?? [];
    const hits: ReferenceHit[] = [];
    for (const def of defs) {
      const hit = toHit(q.project, def.fileName, def.textSpan.start, true);
      if (hit !== null) hits.push(hit);
    }
    return hits;
  }

  async getDiagnostics(files: string[]): Promise<FileDiagnostic[]> {
    const out: FileDiagnostic[] = [];
    for (const file of files) {
      if (!this.supports(file)) continue;
      const abs = resolve(file);
      const project = getProjectForFile(abs);
      if (!project.ensureFile(abs)) continue;
      project.refresh();
      // Guard: getS*Diagnostics throws on files the program doesn't know.
      if (project.service.getProgram()?.getSourceFile(abs) === undefined) continue;
      const raw = [
        ...project.service.getSyntacticDiagnostics(abs),
        ...project.service.getSemanticDiagnostics(abs),
      ];
      for (const d of raw) {
        const mapped = toDiagnostic(abs, d);
        if (mapped !== null) out.push(mapped);
      }
    }
    return out;
  }

  async findSymbolPositions(
    root: string,
    symbolName: string,
    opts?: { limit?: number },
  ): Promise<SymbolLocation[]> {
    const limit = Math.max(1, opts?.limit ?? DEFAULT_SYMBOL_LIMIT);
    const declarations: SymbolLocation[] = [];
    const occurrences: SymbolLocation[] = [];
    for (const file of walkScriptFiles(resolve(root))) {
      if (declarations.length >= limit) break;
      collectSymbolHits(file, symbolName, declarations, occurrences, limit);
    }
    return [...declarations, ...occurrences].slice(0, limit);
  }

  dispose(): void {
    disposeAllProjects();
  }
}
