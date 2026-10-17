/**
 * The literal collections in src/ that name tools: the hand-kept lists a
 * renamed or removed tool leaves a dead entry in (a deny that denies nothing,
 * an essential that never loads). tool-list-registry.test.ts scans them with
 * the compiler's syntax tree, so a list is found whatever shape it takes — an
 * array, a record's keys, a switch over the name, an `a === "x" || a === "y"`
 * chain — and must be registered there (dead-name checked) or derived from the
 * policy rows. A new hand list fails the build instead of rotting.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { BROWSER_TOOL_PARAMETERS } from "./browser-tools/description.js";
import { FLIPPABLE_SETTINGS } from "../settings-schema.js";
import { createCoreProtocolTools } from "../protocols/index.js";

export interface ToolNameCollection {
  /** Repo-relative POSIX path. */
  file: string;
  line: number;
  /** The declaration that owns it — `CONST_NAME`, `.property`, `fn()` — or "?". */
  owner: string;
  kind: "array" | "object-keys" | "switch" | "eq-chain";
  /** Every string literal in the collection, in source order. */
  names: string[];
}

/** Backticked or quoted snake_case names that are NOT tools and never will be:
 *  settings fields (`developer_mode`), browser and protocol actions (`new_tab`,
 *  `save_preference`), and a few plain nouns. Derived from the real tables
 *  where one exists, so a renamed action can't go stale here. */
export function knownNonToolIdentifiers(): Set<string> {
  const browserActions = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: readonly string[] }).enum;
  return new Set([
    ...FLIPPABLE_SETTINGS.map((s) => s.field),
    ...browserActions,
    // The `protocol` family's inner tools: not in the model-facing catalog
    // (the model calls `protocol` with an action), but core callers dispatch
    // them by name, so resolver tables may legitimately list them.
    ...createCoreProtocolTools().map((t) => t.name),
    "save_preference", // `protocol` tool action
    "node_modules",
    "run_id", // what agent_spawn returns
  ]);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (entry === "node_modules" || entry === "vendor") continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$|\.d\.ts$/.test(entry)) out.push(p);
  }
  return out;
}

/** A property of a record a constant holds (`TOOL_COMPANIONS.delete_file`) is
 *  owned by the constant; a property deeper in (`.allowedTools` of each
 *  template) is owned by its name, which every such property shares. */
function ownerOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
      const holder = n.parent.parent;
      if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
      return `.${n.name.text}`;
    }
    if (ts.isFunctionDeclaration(n) && n.name) return `${n.name.text}()`;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return `${n.name.text}()`;
  }
  return "?";
}

/** The `=== "x"` literals of an `||` chain, in order. */
function eqChainLiterals(node: ts.Expression, out: string[] = []): string[] {
  if (ts.isParenthesizedExpression(node)) return eqChainLiterals(node.expression, out);
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) { eqChainLiterals(node.left, out); eqChainLiterals(node.right, out); }
    else if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isStringLiteralLike(node.right)) out.push(node.right.text);
  }
  return out;
}

/** Is this collection about tools? Three tool names make a list; fewer do
 *  when nothing else is in it and either a named constant holds it or two
 *  of them are multi-word names. A lone `=== "build_app"` is a branch, and
 *  `read`/`write` inside a function are also file grants, permission levels
 *  and office actions. */
function namesTools(names: string[], owner: string, isTool: (name: string) => boolean): boolean {
  const toolCount = names.filter(isTool).length;
  if (toolCount >= 3) return toolCount / names.length >= 0.5;
  if (toolCount === 0 || toolCount !== names.length) return false;
  return /^[A-Z][A-Z0-9_]+$/.test(owner) || (toolCount >= 2 && names.some((n) => n.includes("_")));
}

/** Every collection under `root`'s src/ and scripts/ whose literals are
 *  mostly tool names. */
export function scanToolNameCollections(root: string, isTool: (name: string) => boolean): ToolNameCollection[] {
  const found: ToolNameCollection[] = [];
  for (const file of [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "scripts"))]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const record = (node: ts.Node, names: string[], kind: ToolNameCollection["kind"]) => {
      const owner = ownerOf(node);
      if (!namesTools(names, owner, isTool)) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push({ file: relative(root, file).replace(/\\/g, "/"), line: line + 1, owner, kind, names });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node)) {
        const literal = node.elements.filter((e) => !ts.isSpreadElement(e));
        if (literal.every(ts.isStringLiteralLike)) record(node, literal.map((e) => e.text), "array");
      } else if (ts.isObjectLiteralExpression(node)) {
        const keys = node.properties.flatMap((p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []);
        record(node, keys, "object-keys");
      } else if (ts.isSwitchStatement(node)) {
        record(node, node.caseBlock.clauses.flatMap((c) => ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression) ? [c.expression.text] : []), "switch");
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken && !(node.parent && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        record(node, eqChainLiterals(node), "eq-chain");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
