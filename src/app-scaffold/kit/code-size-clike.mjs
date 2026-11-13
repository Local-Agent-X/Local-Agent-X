/**
 * Code lines and function bodies for Kotlin, Java, Swift, C#, C/C++ and Dart,
 * read without a compiler. code-size.mjs calls measureCLike for them; the
 * comment and bracket machinery is code-size-cfamily.mjs's, imported.
 *
 * One lexer pass MASKS the text as code-size-cfamily.mjs does: comments become
 * spaces and every string and char literal becomes `~`, newlines kept. A line
 * holds code when its masked text holds a non-space.
 *
 *   all     line and block comments (block comments nest in Kotlin, Swift, Dart)
 *   Kotlin  "…" and 'c' with escapes; """raw""" (multi-line)
 *   Java    "…" and 'c'; """text blocks"""
 *   Swift   "…"; """multi-line"""; #"raw"# with any number of #
 *   C#      "…" and 'c'; @"verbatim" ("" escapes, multi-line); $"…", $@"…";
 *           """raw""" with three or more quotes
 *   C/C++   "…" and 'c' with u8/u/U/L prefixes; R"delim(raw)delim"; a ' after
 *           a number is a digit separator (1'000), not a char
 *   Dart    '…' and "…"; '''…''' and """…""" (multi-line); r'raw'
 * String interpolation (`${…}`, `\(…)`, `{…}`) is masked with its string.
 *
 * Functions, each counted from its first token to its closing brace, minus the
 * functions nested in it (which count for themselves):
 *   Kotlin  `fun` (an extension `fun T.name` is `name`), `constructor`, `init {}`
 *   Swift   `func`, `init`, `deinit`, `subscript`
 *   Java, C#, C/C++, Dart  a name, its parameters and the `{` that follows
 *           them (past `throws`, `where`, `: base(…)`, a C++ initializer list,
 *           `const`, `async`, a `->` return type). Not a function: control
 *           statements (`if`, `for`, `catch`, `using`, `lock` …), a call (its
 *           `)` is followed by `;`), `new T() {}` and a type's own header.
 *           A C macro used like a statement with a block (`FOREACH(x) {`)
 *           counts as a function: the cost of reading without a compiler.
 * Lambdas and closures belong to the function they are written in. A function
 * inside a class, object, struct, enum, interface, record, protocol, actor,
 * mixin or extension is named `Type.name`; C++'s `Type::name` keeps its own.
 */
import { blockCommentEnd, matchClose, ownLines, quotedEnd, skipSpace } from "./code-size-cfamily.mjs";

const MASK = "~";
const IDENT = /[A-Za-z0-9_]/;
const NESTED_COMMENTS = new Set(["kotlin", "swift", "dart"]);
const startsToken = (t, i) => i === 0 || !IDENT.test(t[i - 1]);

/** End of a literal closed by `close`; a quote run closing a triple-quoted
 *  string takes the extra quotes with it (`""""` ends a string with a `"`). */
function fencedEnd(t, from, close, escapes) {
	for (let j = from; j < t.length; j++) {
		if (escapes && t[j] === "\\") { j++; continue; }
		if (!t.startsWith(close, j)) continue;
		let end = j + close.length;
		while (close[0] === '"' && close.length === 3 && t[end] === '"') end++;
		return end;
	}
	return t.length;
}

const plainQuotes = (t, i, tripleEscapes) => {
	if (t.startsWith('"""', i)) return fencedEnd(t, i + 3, '"""', tripleEscapes);
	return t[i] === '"' || t[i] === "'" ? quotedEnd(t, i, t[i], false) : -1;
};

function swiftLiteralEnd(t, i) {
	let k = i;
	while (t[k] === "#") k++;
	const hashes = t.slice(i, k);
	if (t[k] !== '"') return -1;
	if (t.startsWith('"""', k)) return fencedEnd(t, k + 3, '"""' + hashes, !hashes);
	return hashes ? fencedEnd(t, k + 1, '"' + hashes, false) : quotedEnd(t, k, '"', false);
}

function csharpLiteralEnd(t, i) {
	if (t[i] === "'") return quotedEnd(t, i, "'", false);
	let k = i;
	let verbatim = false;
	while (t[k] === "$" || t[k] === "@") verbatim ||= t[k++] === "@";
	if (t[k] !== '"') return -1;
	let q = k;
	while (t[q] === '"') q++;
	if (q - k >= 3) return fencedEnd(t, q, '"'.repeat(q - k), false);
	if (q - k === 2) return q; // ""
	if (!verbatim) return quotedEnd(t, k, '"', false);
	for (let j = k + 1; j < t.length; j++) {
		if (t[j] !== '"') continue;
		if (t[j + 1] === '"') { j++; continue; }
		return j + 1;
	}
	return t.length;
}

/** A ' inside a number (1'000'000, 0xFF'FF) is a C++14 digit separator. */
function digitSeparator(t, i) {
	let j = i - 1;
	while (j >= 0 && /[0-9A-Za-z_.']/.test(t[j])) j--;
	return /[0-9]/.test(t[j + 1] ?? "");
}

function cLiteralEnd(t, i) {
	let k = i;
	if (startsToken(t, i) && /[uUL]/.test(t[i])) k = t.startsWith("u8", i) ? i + 2 : i + 1;
	if (t[k] === "R" && t[k + 1] === '"' && (k > i || startsToken(t, i))) {
		const open = t.indexOf("(", k + 2);
		if (open < 0) return -1;
		const close = ")" + t.slice(k + 2, open) + '"';
		const at = t.indexOf(close, open);
		return at < 0 ? t.length : at + close.length;
	}
	if (t[k] === '"') return quotedEnd(t, k, '"', false);
	if (t[k] === "'" && !(k === i && digitSeparator(t, i))) return quotedEnd(t, k, "'", false);
	return -1;
}

function dartLiteralEnd(t, i) {
	const raw = t[i] === "r" && (t[i + 1] === "'" || t[i + 1] === '"') && startsToken(t, i);
	const k = raw ? i + 1 : i;
	const q = t[k];
	if (q !== "'" && q !== '"') return -1;
	if (t.startsWith(q.repeat(3), k)) return fencedEnd(t, k + 3, q.repeat(3), !raw);
	if (!raw) return quotedEnd(t, k, q, false);
	for (let j = k + 1; j < t.length; j++) if (t[j] === q || t[j] === "\n") return t[j] === q ? j + 1 : j;
	return t.length;
}

const LITERALS = {
	kotlin: (t, i) => plainQuotes(t, i, false),
	java: (t, i) => plainQuotes(t, i, true),
	swift: swiftLiteralEnd,
	csharp: csharpLiteralEnd,
	c: cLiteralEnd,
	dart: dartLiteralEnd,
};

/** The masked text and the 1-based lines that hold code. */
export function lexCLike(text, dialect) {
	const m = text.split("");
	const fill = (from, to, ch) => {
		for (let k = from; k < to; k++) if (m[k] !== "\n" && m[k] !== "\r") m[k] = ch;
	};
	const literal = LITERALS[dialect];
	for (let i = 0; i < text.length;) {
		if (text[i] === "/" && text[i + 1] === "/") {
			const j = text.indexOf("\n", i);
			fill(i, j < 0 ? text.length : j, " ");
			i = j < 0 ? text.length : j;
			continue;
		}
		if (text[i] === "/" && text[i + 1] === "*") {
			const j = blockCommentEnd(text, i, NESTED_COMMENTS.has(dialect));
			fill(i, j, " ");
			i = j;
			continue;
		}
		const end = literal(text, i);
		if (end > i) { fill(i, end, MASK); i = end; continue; }
		i += 1;
	}
	const masked = m.join("");
	const codeLines = new Set();
	masked.split("\n").forEach((line, k) => { if (/\S/.test(line)) codeLines.add(k + 1); });
	return { masked, codeLines };
}

// ── Function bodies ─────────────────────────────────────────────────────────

/** What may start the next line of a signature that has not reached its `{`. */
const CONTINUES = /^(?:\{|:|,|\.|->|where\b|throws\b|rethrows\b|async\b|const\b|noexcept\b|override\b|final\b|requires\b)/;

/** From the end of a signature's parameters (or a type's name), the `{` that
 *  opens its body, or -1 when a `;`, `=`, closing bracket or an unrelated next
 *  line comes first (a declaration, an expression body, a call). */
function bodyOpen(masked, k) {
	while (k < masked.length) {
		const ch = masked[k];
		if (ch === "{") return k;
		if (ch === ";" || ch === "=" || ch === "}" || ch === ")" || ch === "]") return -1;
		if (ch === "(" || ch === "[") { k = matchClose(masked, k) + 1; continue; }
		if (ch === "\n") {
			const next = skipSpace(masked, k);
			if (!CONTINUES.test(masked.slice(next, next + 12))) return -1;
			k = next;
			continue;
		}
		k += 1;
	}
	return -1;
}

/** Past a `<…>` generic list starting at k. */
function skipAngles(masked, k) {
	let depth = 0;
	for (; k < masked.length; k++) {
		const c = masked[k];
		if (c === "<") depth += 1;
		else if (c === ">" && masked[k - 1] !== "-" && --depth === 0) return k + 1;
		else if (c === "{" || c === ";" || c === "\n") return k;
	}
	return k;
}

/** A function whose parameters open at `paren`: its body's range, or null. */
function withBody(masked, name, start, paren) {
	if (masked[paren] !== "(") return null;
	const open = bodyOpen(masked, matchClose(masked, paren) + 1);
	return open < 0 ? null : { name, start, end: matchClose(masked, open), open };
}

function kotlinFunctions(masked, text) {
	const out = [];
	for (const hit of masked.matchAll(/\b(fun|constructor|init)\b/g)) {
		let k = skipSpace(masked, hit.index + hit[1].length);
		if (hit[1] === "init") {
			if (masked[k] === "{" && masked[hit.index - 1] !== ".") out.push({ name: "init", start: hit.index, end: matchClose(masked, k) });
			continue;
		}
		let name = hit[1];
		if (name === "fun") {
			if (masked[k] === "<") k = skipSpace(masked, skipAngles(masked, k));
			const paren = masked.slice(k).search(/[({=;\n]/) + k;
			// `fun String.trimmed(` is `trimmed`; `fun(x) {}` (anonymous) belongs to its parent.
			name = text.slice(k, paren).trim().split(".").pop().replace(/`/g, "").trim();
			if (!name) continue;
			k = paren;
		}
		const fn = withBody(masked, name, hit.index, k);
		if (fn) out.push(fn);
	}
	return out;
}

function swiftFunctions(masked) {
	const out = [];
	for (const hit of masked.matchAll(/\b(func|init|deinit|subscript)\b/g)) {
		if (masked[hit.index - 1] === ".") continue; // self.init(…), Foo.init(…)
		let k = skipSpace(masked, hit.index + hit[1].length);
		let name = hit[1];
		if (name === "deinit") {
			if (masked[k] === "{") out.push({ name, start: hit.index, end: matchClose(masked, k) });
			continue;
		}
		if (name === "func") {
			name = /^(?:[A-Za-z_]\w*|[^\s\w(<]+)/.exec(masked.slice(k, k + 80))?.[0];
			if (!name) continue;
			k = skipSpace(masked, k + name.length);
		} else if (masked[k] === "?" || masked[k] === "!") k += 1;
		if (masked[k] === "<") k = skipSpace(masked, skipAngles(masked, k));
		const fn = withBody(masked, name, hit.index, k);
		if (fn) out.push(fn);
	}
	return out;
}

const NOT_A_FUNCTION = new Set([
	"if", "for", "foreach", "while", "switch", "catch", "using", "lock", "fixed", "synchronized", "try", "when",
	"return", "sizeof", "typeof", "nameof", "decltype", "alignof", "constexpr", "throw", "await", "else", "do",
	"assert", "super", "this", "base", "defined", "on", "checked", "unchecked", "yield",
]);
const CALLABLE_NAME = /(@?)([A-Za-z_~][\w~]*(?:(?:::|\.)~?[A-Za-z_]\w*)*|operator\s*[^\s\w(]+)\s*(<[^<>(){};]*(?:<[^<>(){};]*>[^<>(){};]*)*>)?\s*$/;

/** Java, C#, C/C++, Dart: a name right before `(` whose `)` leads to a `{`. */
function namedFunctions(masked) {
	const out = [];
	let skipUntil = -1;
	for (let p = masked.indexOf("("); p >= 0; p = masked.indexOf("(", p + 1)) {
		if (p < skipUntil) continue;
		const before = masked.slice(Math.max(0, p - 160), p);
		const m = CALLABLE_NAME.exec(before);
		if (!m || m[1] || NOT_A_FUNCTION.has(m[2].split(/::|\./).pop())) continue; // unnamed, an annotation, a statement
		// The declaration starts with its modifiers and return type: back from the
		// name to the line's start or the `{`, `}` or `;` before it on the line.
		let start = p - (before.length - m.index);
		while (start > 0 && !"\n{};".includes(masked[start - 1])) start -= 1;
		const fn = withBody(masked, m[2].replace(/\s+/g, ""), start, p);
		if (!fn) continue;
		skipUntil = fn.open; // a C++ initializer list or `: base(…)` is part of this header
		// A type's header (`record P(int x) {`, a C# primary constructor) or `new T() {…}`.
		if (/\b(class|struct|record|interface|enum|union|new)\s*$/.test(before.slice(0, m.index))) continue;
		out.push(fn);
	}
	return out;
}

const KEYWORD_AFTER_TYPE_WORD = new Set(["func", "var", "let", "fun", "val", "class", "struct", "interface", "object", "override", "final", "static"]);

/** Classes, objects, structs … with a body, so a member can be named `Type.name`. */
function typeOwners(masked) {
	const out = [];
	for (const hit of masked.matchAll(/\b(class|struct|record|interface|enum|object|extension|protocol|actor|mixin)\s+([A-Za-z_]\w*)/g)) {
		if (KEYWORD_AFTER_TYPE_WORD.has(hit[2])) continue; // Swift `class func`, Kotlin `enum class`
		const open = bodyOpen(masked, hit.index + hit[0].length);
		if (open >= 0) out.push({ type: hit[2], start: open, end: matchClose(masked, open) });
	}
	return out;
}

const FINDERS = { kotlin: kotlinFunctions, swift: swiftFunctions };

/** Code lines and each function's own code lines: `{ code, functions }`. */
export function measureCLike(text, dialect) {
	const { masked, codeLines } = lexCLike(text, dialect);
	const fns = (FINDERS[dialect] ?? namedFunctions)(masked, text);
	const owners = typeOwners(masked);
	for (const f of fns) {
		if (/::|\./.test(f.name) || fns.some((g) => g !== f && g.start < f.start && f.end <= g.end)) continue;
		const owner = owners.filter((o) => o.start < f.start && f.start < o.end).pop();
		if (owner) f.name = `${owner.type}.${f.name}`;
	}
	return { code: codeLines.size, functions: ownLines(masked, fns) };
}
