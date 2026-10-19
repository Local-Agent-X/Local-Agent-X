/**
 * The size measure every structure check shares: CODE lines. A line counts
 * when it holds any token that is not a comment or whitespace; comment lines
 * and blank lines are free. The size rule exists so an agent can find its way
 * around a repo: a file or function that does one job is small enough to read
 * whole. Counting comments would make the documentation the first thing cut
 * to fit, so they never count.
 *
 * Two sizes are measured:
 *   file      the file's code lines.
 *   function  a function's OWN code lines: the lines of its declaration
 *             (signature and body) that hold a token of its own, so a function
 *             nested in it (a callback, an inner def) counts toward itself and
 *             not its parent.
 *
 * How, per language:
 *   TS/JS   the TypeScript compiler API (typescript-api.mjs finds one): each
 *           token of the syntax tree marks the lines from its start to its end,
 *           so a template literal or a regex containing `//` is code. Functions:
 *           declarations, methods, constructors, accessors, and function
 *           expressions and arrow functions with a block body. Without a
 *           TypeScript that has the compiler API (typescript-api.mjs; TypeScript
 *           7's package has none), a lexer approximates the line count and
 *           function sizes are not measured (the check says so).
 *   Python  code-size-python.mjs (docstrings and bare strings are comments; def).
 *   Go/Rust code-size-cfamily.mjs (string-, char- and comment-aware; func/fn
 *           bodies by bracket matching).
 *
 * codebase-map.mjs and check-code-size.mjs import this file, so a project
 * copies it with them.
 */
import { loadTypeScript } from "./typescript-api.mjs";
import { languageOf } from "./project-languages.mjs";
import { measureBraceLanguage } from "./code-size-cfamily.mjs";
import { measurePython } from "./code-size-python.mjs";

/** The new-project caps. A repo with its own passes its numbers as flags. */
export const DEFAULT_LIMITS = { maxCode: 400, warnCode: 320, maxFn: 100, warnFn: 60 };

const FLAGS = { maxCode: "--max-code", warnCode: "--warn-code", maxFn: "--max-fn", warnFn: "--warn-fn" };

/** The caps from argv (`--max-code 350 --warn-code 280 --max-fn 100 --warn-fn 60`). */
export function limitsFromArgs(args) {
	const limits = { ...DEFAULT_LIMITS };
	for (const [key, flag] of Object.entries(FLAGS)) {
		const i = args.indexOf(flag);
		if (i >= 0) limits[key] = Number(args[i + 1]);
	}
	return limits;
}

/** The same caps as flags, for a script that hands them on. */
export const limitArgs = (limits) => Object.entries(FLAGS).flatMap(([key, flag]) => [flag, String(limits[key])]);

function scriptKind(ts, file) {
	if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
	if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

const propName = (ts, sf, name) => (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) ? name.text : name?.getText(sf) ?? "");

/** The name an object or class goes by: its own, or the variable or
 *  property it is assigned to; "" when it has none. */
function holderName(ts, sf, node) {
	if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) return node.name.text;
	const p = node.parent;
	if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
	if (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return propName(ts, sf, p.name);
	// An unnamed object that names itself: `{ name: "memory_save", execute() {…} }`.
	if (ts.isObjectLiteralExpression(node)) {
		const own = node.properties.find((q) => ts.isPropertyAssignment(q) && ["name", "id"].includes(propName(ts, sf, q.name))
			&& (ts.isStringLiteral(q.initializer) || ts.isNoSubstitutionTemplateLiteral(q.initializer)));
		if (own) return own.initializer.text;
	}
	return "";
}

/** The nearest enclosing measured function, for naming one it returns. */
function enclosingFunction(ts, node) {
	for (let p = node.parent; p; p = p.parent) if (isMeasuredFunction(ts, p)) return p;
	return null;
}

const qualified = (holder, name) => (holder ? `${holder}.${name}` : name);

/** A stable, readable name for a measured function. A callback is named after
 *  what it is passed to (`app.get:callback`). */
function functionName(ts, sf, node) {
	if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "default";
	if (ts.isConstructorDeclaration(node)) return qualified(holderName(ts, sf, node.parent), "constructor");
	if (ts.isMethodDeclaration(node) || ts.isAccessor(node)) return qualified(holderName(ts, sf, node.parent), propName(ts, sf, node.name));
	if (ts.isFunctionExpression(node) && node.name) return node.name.text;
	let child = node;
	let p = node.parent;
	while (p && ts.isParenthesizedExpression(p)) { child = p; p = p.parent; }
	if (!p) return "anonymous";
	if (ts.isVariableDeclaration(p)) return ts.isIdentifier(p.name) ? p.name.text : "destructured";
	if (ts.isPropertyAssignment(p)) return qualified(holderName(ts, sf, p.parent), propName(ts, sf, p.name));
	if (ts.isPropertyDeclaration(p)) return qualified(holderName(ts, sf, p.parent), propName(ts, sf, p.name));
	if (ts.isBinaryExpression(p) && p.right === child) return p.left.getText(sf).replace(/\s+/g, "");
	if (ts.isExportAssignment(p)) return "default";
	if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === child)) {
		const outer = ts.isArrowFunction(p) ? p : enclosingFunction(ts, p);
		return outer ? `${functionName(ts, sf, outer)}:returned` : "returned";
	}
	if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === child) return "iife";
	if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
		const callee = p.expression.getText(sf).replace(/\s+/g, "").split(".").slice(-2).join(".");
		return `${/^[\w$.]+$/.test(callee) ? callee : "call"}:callback`;
	}
	return "anonymous";
}

function isMeasuredFunction(ts, node) {
	if (ts.isArrowFunction(node)) return ts.isBlock(node.body);
	return Boolean(node.body) && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
		|| ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node));
}

function measureTypeScript(ts, file, text) {
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
	const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
	const code = new Set();
	const functions = [];
	const visit = (node, owner) => {
		if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
		const children = node.getChildren(sf);
		if (children.length === 0) {
			if (node.kind === ts.SyntaxKind.EndOfFileToken || (ts.isJsxText(node) && node.containsOnlyTriviaWhiteSpaces)) return;
			const start = node.getStart(sf);
			if (node.end <= start) return;
			for (let l = lineOf(start), last = lineOf(node.end - 1); l <= last; l++) {
				code.add(l);
				owner?.own.add(l);
			}
			return;
		}
		const fn = isMeasuredFunction(ts, node) ? { name: functionName(ts, sf, node), line: lineOf(node.getStart(sf)), own: new Set() } : null;
		if (fn) functions.push(fn);
		for (const child of children) visit(child, fn ?? owner);
	};
	visit(sf, null);
	return { code: code.size, functions: functions.map((f) => ({ name: f.name, line: f.line, code: f.own.size })) };
}

/**
 * The code lines of one source file and, where measured, each function's own
 * code lines: `{ code, functions: [{ name, line, code }] | null, approximate }`.
 * `functions` is null when the language's function sizes are not measured
 * (JS/TS without a TypeScript that has the compiler API: typescript-api.mjs).
 */
export function measureSource(file, text, repo = process.cwd()) {
	const lang = languageOf(file)?.id;
	if (lang === "python") return { ...measurePython(text), approximate: false };
	if (lang === "go" || lang === "rust") return { ...measureBraceLanguage(text, lang), approximate: false };
	const { ts } = loadTypeScript(repo);
	if (ts) return { ...measureTypeScript(ts, file, text), approximate: false };
	return { ...measureBraceLanguage(text, "js"), approximate: true };
}

/**
 * One file's measured items as the checks key them: the file (`src/a.ts`) and
 * each function (`src/a.ts#Store.save`; `@line` is appended only when two
 * functions in the file share a name). `kind` is "file" or "function".
 */
export function sizeItems(rel, measured) {
	const items = [{ key: rel, kind: "file", size: measured.code, line: 1 }];
	const fns = measured.functions ?? [];
	const count = new Map();
	for (const f of fns) count.set(f.name, (count.get(f.name) ?? 0) + 1);
	for (const f of fns) {
		items.push({ key: `${rel}#${f.name}${count.get(f.name) > 1 ? `@${f.line}` : ""}`, kind: "function", size: f.code, line: f.line });
	}
	return items;
}

/** "over", "near" (the warning band) or "ok" for an item under the caps. */
export function bandOf(item, limits) {
	const [cap, warn] = item.kind === "file" ? [limits.maxCode, limits.warnCode] : [limits.maxFn, limits.warnFn];
	return item.size > cap ? "over" : item.size > warn ? "near" : "ok";
}

export const capOf = (item, limits) => (item.kind === "file" ? limits.maxCode : limits.maxFn);
export const unitOf = (item) => (item.kind === "file" ? "code lines" : "own code lines");

/** Markdown bullets for the codebase map's "Nearing the size cap" section:
 *  largest first, sizes in tens so a small edit does not rewrite the map. */
export function nearingSection(items, limits) {
	const near = items.filter((it) => bandOf(it, limits) === "near").map((it) => ({ ...it, tens: Math.floor(it.size / 10) * 10 }));
	near.sort((a, b) => b.tens - a.tens || a.key.localeCompare(b.key));
	return near.map((it) => `- \`${it.key}\` — ${it.tens}+ ${unitOf(it)} (cap ${capOf(it, limits)})`);
}
