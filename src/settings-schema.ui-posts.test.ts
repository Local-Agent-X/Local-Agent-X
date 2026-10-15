/**
 * Every key the shipped UI posts to /api/settings is declared in
 * FLIPPABLE_SETTINGS. The route refuses an undeclared key, so a UI change that
 * posts a new one without declaring it (and saying who owns it) would fail
 * silently in the app; this fails it here instead.
 *
 * The scan reads public/ with the TypeScript parser and follows each POST body
 * back to its keys: object literals, a local payload built up by assignment,
 * and a field name or patch passed in by a caller (including the inline
 * handlers in the HTML). It fails closed: a POST, or any use of the settings
 * URL, whose keys it cannot follow is reported, so a new way of posting
 * cannot slip past it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { settingSpec } from "./settings-schema.js";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const URL_TEXT = "/api/settings";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "vendor" ? [] : filesUnder(p);
    return /\.(js|html)$/.test(name) ? [p] : [];
  });
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every script in public/: each .js file, and each inline <script> and on*="" handler of each .html file. */
function scripts(): ts.SourceFile[] {
  const out: ts.SourceFile[] = [];
  for (const file of filesUnder(PUBLIC)) {
    const text = readFileSync(file, "utf-8");
    const name = relative(PUBLIC, file).replace(/\\/g, "/");
    const parse = (code: string, label: string) => out.push(ts.createSourceFile(label, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
    if (file.endsWith(".js")) { parse(text, name); continue; }
    let i = 0;
    for (const m of text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) parse(m[1], `${name}#script${i++}`);
    for (const m of text.matchAll(/\son[a-z]+="([^"]*)"/gi)) parse(decode(m[1]), `${name}#handler${i++}`);
  }
  return out;
}

function nodesOf(sf: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (n: ts.Node) => { all.push(n); ts.forEachChild(n, visit); };
  visit(sf);
  return all;
}

class Unresolved extends Error {}
const where = (n: ts.Node) => `${n.getSourceFile().fileName}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
const fail = (n: ts.Node, why: string): never => { throw new Unresolved(`${where(n)}: ${why}`); };

const SOURCES = scripts();
const NODES = SOURCES.flatMap(nodesOf);
const CALLS = NODES.filter(ts.isCallExpression);

function calleeName(call: ts.CallExpression): string | undefined {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "window") return c.name.text;
  return undefined;
}

function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
}

type Binding = { kind: "param"; fn: ts.SignatureDeclaration; index: number } | { kind: "var"; decl: ts.VariableDeclaration; scope: ts.Node };

function bindingOf(id: ts.Identifier): Binding {
  for (let n: ts.Node = id.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const index = n.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === id.text);
      if (index >= 0) return { kind: "param", fn: n, index };
    }
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) {
      const decl = nodesOf(n).find((d): d is ts.VariableDeclaration =>
        ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.name.text === id.text);
      if (decl) return { kind: "var", decl, scope: n };
    }
  }
  return fail(id, `cannot find where ${id.text} is defined`);
}

/** The argument every caller of `fn` passes at `index`. */
function callerArgs(fn: ts.SignatureDeclaration, index: number, at: ts.Node): ts.Expression[] {
  const name = functionName(fn) ?? fail(at, "the value comes from a parameter of an unnamed function");
  const args = CALLS.filter((c) => calleeName(c) === name).map((c) => c.arguments[index] ?? fail(c, `${name}() called without argument ${index}`));
  return args.length > 0 ? args : fail(at, `${name}() is never called, so its argument cannot be followed`);
}

/** The string values `expr` (a field name) can take. */
function names(expr: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expr)) return [expr.text];
  if (ts.isIdentifier(expr)) {
    const b = bindingOf(expr);
    if (b.kind === "param") return callerArgs(b.fn, b.index, expr).flatMap(names);
  }
  return fail(expr, `cannot tell which field ${expr.getText()} names`);
}

/** The settings keys an expression posted as the body can carry. */
function keys(expr: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(expr)) return keys(expr.expression);
  if (ts.isCallExpression(expr) && expr.expression.getText() === "JSON.stringify") return keys(expr.arguments[0]);
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.flatMap((p) => {
      if (ts.isSpreadAssignment(p)) return keys(p.expression);
      if (p.name && ts.isComputedPropertyName(p.name)) return names(p.name.expression);
      if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return [p.name.text];
      return fail(p, "unsupported property in a posted object");
    });
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // tier.settings and the like: every object literal assigned to that property anywhere in public/.
    const prop = expr.name.text;
    const sources = NODES.filter((n): n is ts.PropertyAssignment =>
      ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === prop && ts.isObjectLiteralExpression(n.initializer));
    return sources.length > 0 ? sources.flatMap((s) => keys(s.initializer)) : fail(expr, `no object literal is ever assigned to .${prop}`);
  }
  if (ts.isIdentifier(expr)) {
    const b = bindingOf(expr);
    if (b.kind === "param") return callerArgs(b.fn, b.index, expr).flatMap(keys);
    const built = nodesOf(b.scope).flatMap((n) => {
      if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return [];
      const target = n.left;
      if (ts.isPropertyAccessExpression(target) && target.expression.getText() === expr.text) return [target.name.text];
      if (ts.isElementAccessExpression(target) && target.expression.getText() === expr.text) return names(target.argumentExpression);
      return [];
    });
    return [...(b.decl.initializer ? keys(b.decl.initializer) : []), ...built];
  }
  return fail(expr, `cannot follow the posted body ${expr.getText().slice(0, 60)}`);
}

const isSettingsUrl = (e: ts.Expression | undefined): boolean =>
  !!e && ((ts.isStringLiteralLike(e) && e.text === URL_TEXT) ||
    (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && isSettingsUrl(e.right)));

/** The body a call to the settings URL posts, or null for a read. */
function postedBody(call: ts.CallExpression): ts.Expression | null {
  const name = calleeName(call);
  if (name === "apiPost") return call.arguments[1] ?? fail(call, "apiPost without a body");
  if (name !== "fetch" && name !== "apiFetch" && name !== "apiJson") return fail(call, `unrecognized call ${call.expression.getText()}(${URL_TEXT})`);
  const opts = call.arguments[1];
  if (!opts) return null;
  if (!ts.isObjectLiteralExpression(opts)) return fail(opts, "request options are not an object literal");
  const prop = (k: string) => opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === k);
  const method = prop("method")?.initializer;
  if (!method || (ts.isStringLiteralLike(method) && method.text.toUpperCase() === "GET")) return null;
  if (!ts.isStringLiteralLike(method) || method.text.toUpperCase() !== "POST") return fail(method, "request method is not a literal GET or POST");
  return prop("body")?.initializer ?? fail(opts, "POST without a body");
}

function scan(): { posted: Map<string, string>; unresolved: string[] } {
  const posted = new Map<string, string>();
  const unresolved: string[] = [];
  const attempt = (f: () => void) => {
    try { f(); } catch (e) { if (e instanceof Unresolved) unresolved.push(e.message); else throw e; }
  };
  for (const call of CALLS.filter((c) => isSettingsUrl(c.arguments[0]))) {
    attempt(() => {
      const body = postedBody(call);
      if (body) for (const key of keys(body)) if (!posted.has(key)) posted.set(key, where(call));
    });
  }
  for (const lit of NODES.filter((n): n is ts.StringLiteralLike => ts.isStringLiteralLike(n) && n.text === URL_TEXT)) {
    let arg: ts.Node = lit;
    while (ts.isBinaryExpression(arg.parent) && arg.parent.right === arg) arg = arg.parent;
    if (!(ts.isCallExpression(arg.parent) && arg.parent.arguments[0] === arg)) {
      attempt(() => fail(lit, `${URL_TEXT} used outside a call this scan can follow`));
    }
  }
  return { posted, unresolved };
}

describe("keys the UI posts to /api/settings", () => {
  const { posted, unresolved } = scan();

  it("are all followed back to their source", () => {
    expect(unresolved).toEqual([]);
  });

  it("finds the posts it is meant to (the scan is not blind)", () => {
    for (const key of ["enableShell", "palette", "workspace", "voiceSttProvider", "voiceTier4Device", "dailyBudgetUsd", "onboarded"]) {
      expect(posted.has(key), key).toBe(true);
    }
  });

  it("are every one declared in FLIPPABLE_SETTINGS", () => {
    const undeclared = [...posted].filter(([key]) => !settingSpec(key)).map(([key, at]) => `${key} (${at})`);
    expect(undeclared).toEqual([]);
  });
});
