/**
 * Every file under src/ that touches a network primitive itself: a socket
 * module (`http`, `https`, `net`, `tls`, `dgram`, `http2`), a network client
 * package (`undici`, `ws`, a mail client, a provider SDK, a messaging or media
 * peer, the browser engine), or the global `fetch` / `WebSocket` /
 * `EventSource`. network-primitive-registry.test.ts holds the registered
 * exceptions, so a new direct caller fails the build instead of quietly
 * skipping the egress judge (docs/proposals/egress-consolidation.md, phase 7).
 *
 * The scan reads the compiler's syntax tree, not the text: a type-only import
 * (`import type { IncomingMessage }`) is not a use, a string holding a script
 * is not code, a local binding named `fetch` is not the global, and a dynamic
 * `import()` or a `createRequire` load is as much a use as a static import.
 *
 * Name resolution (`dns`) is not scanned: a lookup carries only a hostname,
 * and the proposal lists DNS as a side channel outside the boundary.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** What a file does with the network. `outbound` dials out; `server` listens;
 *  `browser` launches or attaches the browser engine, whose page traffic the
 *  browser's own egress worker judges per request. */
export type NetworkUse = "outbound" | "server" | "browser";

export interface NetworkPrimitiveUser {
  /** Repo-relative POSIX path. */
  file: string;
  /** Sorted, distinct. */
  uses: NetworkUse[];
  /** One `module.member` (or global) per distinct use site, for messages. */
  evidence: string[];
}

type Classifier = (member: string) => NetworkUse | null;

const SOCKET_SERVERS = new Set(["createServer", "createSecureServer", "Server"]);
/** Members of the socket modules that carry no traffic: parsing, constants,
 *  address checks, and the request/response classes a handler is typed with. */
const SOCKET_NEUTRAL = new Set([
  "STATUS_CODES", "METHODS", "IncomingMessage", "ServerResponse", "OutgoingMessage",
  "validateHeaderName", "validateHeaderValue", "maxHeaderSize", "constants",
  "isIP", "isIPv4", "isIPv6", "BlockList", "SocketAddress",
  "rootCertificates", "getCiphers", "checkServerIdentity", "createSecureContext",
  "DEFAULT_MIN_VERSION", "DEFAULT_MAX_VERSION", "DEFAULT_CIPHERS", "DEFAULT_ECDH_CURVE",
]);
const socketModule: Classifier = (m) => SOCKET_SERVERS.has(m) ? "server" : SOCKET_NEUTRAL.has(m) ? null : "outbound";
const WS_NEUTRAL = new Set(["CONNECTING", "OPEN", "CLOSING", "CLOSED", "RawData"]);
const wsModule: Classifier = (m) => m === "WebSocketServer" || m === "Server" ? "server" : WS_NEUTRAL.has(m) ? null : "outbound";
const PLAYWRIGHT_NEUTRAL = new Set(["errors", "devices", "selectors"]);
/** Playwright's `request` is an HTTP client of its own, outside the page. */
const playwrightModule: Classifier = (m) => m === "request" ? "outbound" : PLAYWRIGHT_NEUTRAL.has(m) ? null : "browser";
/** The methods of a Playwright APIRequestContext (`page.request.get(url)`),
 *  which send from the browser context's cookie jar but outside its pages, so
 *  the browser's per-request egress worker never sees them. */
const API_REQUEST_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "fetch"]);

function importsPlaywright(source: ts.SourceFile): boolean {
  return source.statements.some((st) => ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "playwright");
}

/** `<x>.request.get(...)` and its siblings. */
function isApiRequestCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && API_REQUEST_METHODS.has(callee.name.text)
    && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "request";
}
const UNDICI_NEUTRAL = new Set(["Headers", "FormData", "File", "Blob", "errors"]);
const undiciModule: Classifier = (m) => UNDICI_NEUTRAL.has(m) ? null : "outbound";
const anyUseDials: Classifier = () => "outbound";

/** Module specifier (without `node:`) to how its members are classified.
 *  The packages are the network clients in package.json `dependencies`. */
const MODULES: Record<string, Classifier> = {
  http: socketModule, https: socketModule, net: socketModule, tls: socketModule, http2: socketModule,
  dgram: anyUseDials,
  undici: undiciModule,
  ws: wsModule,
  nodemailer: anyUseDials,
  imapflow: anyUseDials,
  openai: anyUseDials,
  "@whiskeysockets/baileys": anyUseDials,
  "msedge-tts": anyUseDials,
  werift: anyUseDials,
  "kokoro-js": anyUseDials,
  playwright: playwrightModule,
};

/** Globals that dial when referenced; a local binding of the same name is not
 *  one of them. */
const NETWORK_GLOBALS = new Set(["fetch", "WebSocket", "EventSource"]);

function classifierFor(specifier: string): { module: string; classify: Classifier } | null {
  const bare = specifier.replace(/^node:/, "");
  const base = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0];
  return Object.hasOwn(MODULES, base) ? { module: base, classify: MODULES[base] } : null;
}

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

function statementDeclares(st: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.some((d) => bindingNames(d.name).includes(name));
  if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) return st.name?.text === name;
  if (ts.isImportDeclaration(st)) {
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) return false;
    if (clause.name?.text === name) return true;
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) return nb.name.text === name;
    return !!nb && nb.elements.some((e) => !e.isTypeOnly && e.name.text === name);
  }
  return false;
}

/** The nearest node that binds `name` in scope at `from`, or undefined when
 *  the name is free (a global). Syntactic: `var` hoisting out of a block is
 *  not followed. */
function bindingScope(from: ts.Node, name: string): ts.Node | undefined {
  for (let n = from.parent; n; n = n.parent) {
    if ((ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n))
      && n.statements.some((st) => statementDeclares(st, name))) return n;
    if (ts.isFunctionLike(n) && n.parameters.some((p) => bindingNames(p.name).includes(name))) return n;
    if ((ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.name?.text === name) return n;
    if ((ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)
      && n.initializer.declarations.some((d) => bindingNames(d.name).includes(name))) return n;
    if (ts.isCatchClause(n) && n.variableDeclaration && bindingNames(n.variableDeclaration.name).includes(name)) return n;
  }
  return undefined;
}

/** Is this identifier a runtime read of a binding (not a declaration's name,
 *  a property name, or a type)? */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p)) return p.name === id;
  if ((p as { name?: ts.Node }).name === id || (p as { propertyName?: ts.Node }).propertyName === id) return false;
  if (ts.isQualifiedName(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p)) return false;
  for (let n: ts.Node = id; n.parent && !ts.isSourceFile(n.parent); n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)) return n.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent.parent);
    if (ts.isTypeNode(n)) return false;
  }
  return true;
}

/** The member an expression holding a module (or a module export) is used
 *  for: `x.member`, `new x()`, `const { member } = x`, or `*` when it is
 *  passed on whole. Parentheses, `await` and `as` are seen through. */
function memberOf(expr: ts.Node): string {
  let n = expr;
  while (ts.isParenthesizedExpression(n.parent) || ts.isAwaitExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isNonNullExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === n) return p.name.text;
  if (ts.isNewExpression(p) && p.expression === n) return "new";
  if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isObjectBindingPattern(p.name)) {
    const names = p.name.elements.map((e) => (e.propertyName ?? e.name).getText());
    return names.length === 1 ? names[0] : `{${names.join(",")}}`;
  }
  return "*";
}

function classifyMembers(classify: Classifier, member: string): NetworkUse[] {
  const members = member.startsWith("{") ? member.slice(1, -1).split(",") : [member];
  return members.flatMap((m) => { const u = classify(m); return u ? [u] : []; });
}

/** Names this file binds to a `createRequire(...)` result. */
function requireFunctions(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "createRequire") names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The module a call loads at runtime: `import("x")`, `require("x")` through
 *  a createRequire binding, or `createRequire(...)("x")`. */
function loadedModule(node: ts.CallExpression, requires: Set<string>): string | null {
  const arg = node.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg)) return null;
  const callee = node.expression;
  const loads = callee.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(callee) && requires.has(callee.text))
    || (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "createRequire");
  return loads ? arg.text : null;
}

/** Local import bindings to the network module (and member) they hold. */
function importedBindings(source: ts.SourceFile): Map<string, { module: string; classify: Classifier; member: string | null }> {
  const out = new Map<string, { module: string; classify: Classifier; member: string | null }>();
  for (const st of source.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const mod = classifierFor(st.moduleSpecifier.text);
    const clause = st.importClause;
    if (!mod || !clause || clause.isTypeOnly) continue;
    // A default import of `ws` is the WebSocket client class.
    if (clause.name) out.set(clause.name.text, { ...mod, member: mod.module === "ws" ? "WebSocket" : null });
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.set(nb.name.text, { ...mod, member: null });
    else if (nb) for (const e of nb.elements) if (!e.isTypeOnly) out.set(e.name.text, { ...mod, member: (e.propertyName ?? e.name).text });
  }
  return out;
}

/** Every use of a network primitive in one source file. */
export function scanSourceForNetworkUse(source: ts.SourceFile): { uses: NetworkUse[]; evidence: string[] } {
  const uses = new Set<NetworkUse>();
  const evidence = new Map<string, number>();
  let at: ts.Node = source;
  const note = (found: NetworkUse[], label: string) => {
    for (const u of found) {
      uses.add(u);
      const key = `${label} (${u})`;
      if (!evidence.has(key)) evidence.set(key, source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1);
    }
  };
  const imports = importedBindings(source);
  const requires = requireFunctions(source);
  const drivesBrowser = importsPlaywright(source);
  const visit = (node: ts.Node): void => {
    at = node;
    if (ts.isCallExpression(node)) {
      const loaded = loadedModule(node, requires);
      const mod = loaded ? classifierFor(loaded) : null;
      if (mod) { const member = memberOf(node); note(classifyMembers(mod.classify, member), `${mod.module}.${member}`); }
      if (drivesBrowser && isApiRequestCall(node)) note(["outbound"], "playwright APIRequestContext");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      const mod = classifierFor(node.moduleSpecifier.text);
      if (mod) note(["outbound"], `${mod.module} re-export`);
    } else if (ts.isIdentifier(node) && isValueReference(node)) {
      const bound = imports.get(node.text);
      if (bound && bindingScope(node, node.text) === source) {
        const used = memberOf(node);
        // A named class import read as `X.OPEN` is the constant, not the class.
        const member = bound.member === null ? used : used === "new" || used === "*" ? bound.member : used;
        note(classifyMembers(bound.classify, member), `${bound.module}.${member}`);
      } else if (NETWORK_GLOBALS.has(node.text) && !bindingScope(node, node.text)) {
        if (memberOf(node) === "new" || ts.isCallExpression(node.parent) || node.text === "fetch") note(["outbound"], `global ${node.text}`);
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "globalThis" && NETWORK_GLOBALS.has(node.name.text)) {
      note(["outbound"], `global ${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { uses: [...uses].sort(), evidence: [...evidence].map(([label, line]) => `${label} :${line}`).sort() };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$|\.test-helper\.ts$|\.d\.ts$/.test(entry)) out.push(p);
  }
  return out;
}

/** Every non-test file under `root`'s src/ that uses a network primitive. */
export function scanNetworkPrimitiveUsers(root: string): NetworkPrimitiveUser[] {
  const found: NetworkPrimitiveUser[] = [];
  for (const file of sourceFiles(join(root, "src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const { uses, evidence } = scanSourceForNetworkUse(source);
    if (uses.length) found.push({ file: relative(root, file).replace(/\\/g, "/"), uses, evidence });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}
