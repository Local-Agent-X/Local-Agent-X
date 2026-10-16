// The file-access gate resolves a tool's relative path with the call's session
// (resolveAgentPathFrom(ws, p, ctx.sessionId)), so in a work-rooted session —
// a delegated build worker, an IDE project — "x" means <workRoot>/x. Every
// sink, and every harness check about the same argument, has to resolve it
// with that session too, or it opens (stats, records, deletes) a different
// file from the one the gate approved. view_image, ocr, the office families,
// sql_*, create_chart, extract_site_assets, android install_apk, process_start
// cwd, memory_ingest, email attachments, the stale-read guard, read-dedup and
// the delete gate all resolved without it.
//
// This scan reads the source of every tool and of the dispatch pipeline and
// fails on a call to a session-taking path resolver that omits the session or
// passes a literal `undefined`. The resolvers are not a hand list: starting
// from resolveAgentPath / resolveAgentPathFrom, any function that forwards one
// of its own parameters into a resolver's session slot is itself a resolver,
// so its callers are held to the same rule (chartOutPath, resolveMediaPath,
// startSession, canonicalizeAttachmentPath, ...).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";
import fg from "fast-glob";

const SCANNED = ["src/tools/**/*.ts", "src/tool-execution/**/*.ts", "src/*/tools/**/*.ts"];
const NOT_SOURCE = ["**/*.test.ts", "**/*.test-helper.ts"];

// Calls that resolve without the session on purpose. Key: "<file>: <call>".
const EXEMPT: Record<string, string> = {
  "src/tools/dev-server.ts: startSession(command, cwd, env)":
    "the dev-server lifecycle passes the app's own absolute directory, never a model-supplied path, and an absolute path resolves the same with or without a session",
};

/** "<file>#<function>" → index of its session parameter. */
type Resolvers = Map<string, number>;
const BASE: Array<[string, number]> = [
  ["src/workspace/paths.ts#resolveAgentPath", 1],
  ["src/workspace/paths.ts#resolveAgentPathFrom", 2],
];

interface Violation { key: string; at: string }

function importedBindings(file: string, sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const target = posix.join(posix.dirname(file), spec).replace(/\.js$/, ".ts");
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) out.set(el.name.text, `${target}#${(el.propertyName ?? el.name).text}`);
  }
  return out;
}

function functionName(fn: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return undefined;
}

/** The function whose parameter `name` is, seen from `node` (closures included). */
function declaringFunction(node: ts.Node, name: string): { fn: ts.SignatureDeclaration; index: number } | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (!(ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n))) continue;
    const index = n.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (index >= 0) return { fn: n, index };
  }
  return undefined;
}

function resolverCalls(file: string, sf: ts.SourceFile, resolvers: Resolvers, visit: (call: ts.CallExpression, key: string, slot: number) => void): void {
  const imported = importedBindings(file, sf);
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const key = imported.get(name) ?? `${file}#${name}`;
      const slot = resolvers.get(key);
      if (slot !== undefined) visit(node, key, slot);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

/**
 * The source tree, parsed on demand. A file can call a resolver only if its
 * text names one, so only those files are parsed: the scan stays fast however
 * large src/ grows (parsing every file outran the test timeout on a loaded CI
 * runner).
 */
class Sources {
  private readonly parsed = new Map<string, ts.SourceFile>();
  constructor(readonly texts: ReadonlyMap<string, string>) {}
  get(file: string): ts.SourceFile {
    let sf = this.parsed.get(file);
    if (!sf) { sf = parse(file, this.texts.get(file)!); this.parsed.set(file, sf); }
    return sf;
  }
  /** The files whose text names any of these functions. */
  naming(names: ReadonlySet<string>): string[] {
    return [...this.texts].filter(([, text]) => [...names].some((n) => text.includes(n))).map(([f]) => f);
  }
}

const resolverName = (key: string): string => key.split("#")[1];

/** Every resolver, base and forwarding wrapper, found to a fixpoint over `sources`. */
function discoverResolvers(sources: Sources): Resolvers {
  const resolvers: Resolvers = new Map(BASE);
  for (let grew = true; grew;) {
    grew = false;
    const names = new Set([...resolvers.keys()].map(resolverName));
    for (const file of sources.naming(names)) {
      const sf = sources.get(file);
      resolverCalls(file, sf, resolvers, (call, _key, slot) => {
        const arg = call.arguments[slot];
        if (!arg || !ts.isIdentifier(arg)) return;
        const declared = declaringFunction(call, arg.text);
        const name = declared && functionName(declared.fn);
        if (!declared || !name) return;
        const key = `${file}#${name}`;
        if (!resolvers.has(key)) { resolvers.set(key, declared.index); grew = true; }
      });
    }
  }
  return resolvers;
}

function isUndefinedLiteral(e: ts.Expression): boolean {
  return (ts.isIdentifier(e) && e.text === "undefined") || ts.isVoidExpression(e);
}

/** Calls in `scanned` that resolve a path without the call's session. */
function sessionlessResolves(sources: Sources, scanned: Iterable<string>): Violation[] {
  const resolvers = discoverResolvers(sources);
  const definers = new Set([...resolvers.keys()].map((k) => k.split("#")[0]));
  const naming = new Set(sources.naming(new Set([...resolvers.keys()].map(resolverName))));
  const out: Violation[] = [];
  for (const file of scanned) {
    for (const m of sources.texts.get(file)!.matchAll(/\bimport\(\s*["'](\.[^"']*)["']\s*\)/g)) {
      const target = posix.join(posix.dirname(file), m[1]).replace(/\.js$/, ".ts");
      if (definers.has(target)) out.push({ key: `${file}: import("${m[1]}")`, at: `${file}: import("${m[1]}") loads a path resolver where this scan cannot follow its calls; import it statically` });
    }
    if (!naming.has(file)) continue;
    const sf = sources.get(file);
    resolverCalls(file, sf, resolvers, (call, key, slot) => {
      const arg = call.arguments[slot];
      if (arg && !isUndefinedLiteral(arg)) return;
      const text = call.getText(sf).replace(/\s+/g, " ");
      const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
      out.push({ key: `${file}: ${text}`, at: `${file}:${line} ${text} (${key.split("#")[1]} takes the session as argument ${slot + 1})` });
    });
  }
  return out;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

describe("every agent-path resolve in a tool or the dispatch pipeline carries the call's session", () => {
  it("source scan", async () => {
    const all = await fg("src/**/*.ts", { ignore: NOT_SOURCE });
    const scanned = new Set(await fg(SCANNED, { ignore: NOT_SOURCE }));
    const sources = new Sources(new Map(all.map((f) => [f, readFileSync(f, "utf8")])));
    const resolvers = discoverResolvers(sources);
    // The scan has to see the resolvers it is guarding, or it proves nothing.
    expect([...resolvers.keys()]).toEqual(expect.arrayContaining([
      "src/tools/shared/media-path.ts#resolveMediaPath",
      "src/tools/chart-tools.ts#chartOutPath",
      "src/tools/process-session.ts#startSession",
      "src/tools/http-egress-guard.ts#canonicalizeAttachmentPath",
    ]));
    const found = sessionlessResolves(sources, scanned);
    const violations = found.filter((v) => !(v.key in EXEMPT)).map((v) => v.at);
    expect(violations, `Resolve these with the call's session (sessionIdOf(args) in a tool, ctx.sessionId in the pipeline):\n  ${violations.join("\n  ")}`).toEqual([]);
    const stale = Object.keys(EXEMPT).filter((k) => !found.some((v) => v.key === k));
    expect(stale, "exemptions that no longer match a call").toEqual([]);
  });

  it("the scan follows aliases and wrappers and flags an omitted or undefined session", () => {
    const sources = new Sources(new Map([
      ["src/tools/wrap.ts", [
        'import { resolveAgentPath as rap } from "../workspace/paths.js";',
        "export function wrapped(p: string, sid?: string) { return rap(p, sid); }",
        "export const viaArrow = (p: string, s: string | undefined) => wrapped(p, s);",
      ].join("\n")],
      ["src/tools/use.ts", [
        'import { wrapped, viaArrow } from "./wrap.js";',
        'import { resolveAgentPath } from "../workspace/paths.js";',
        "export function a(args: Record<string, unknown>) {",
        "  resolveAgentPath(String(args.path));",
        "  wrapped(String(args.path));",
        "  viaArrow(String(args.path), undefined);",
        "  resolveAgentPath(String(args.path), sessionIdOf(args));",
        "}",
      ].join("\n")],
    ]));
    const found = sessionlessResolves(sources, ["src/tools/use.ts"]).map((v) => v.key);
    expect(found).toEqual([
      "src/tools/use.ts: resolveAgentPath(String(args.path))",
      "src/tools/use.ts: wrapped(String(args.path))",
      "src/tools/use.ts: viaArrow(String(args.path), undefined)",
    ]);
  });
});
