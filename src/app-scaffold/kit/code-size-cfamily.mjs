/**
 * Code lines and function bodies for the brace languages the kit reads
 * without a compiler: Go, Rust, and JavaScript when the project has no
 * `typescript` package (code-size.mjs uses the compiler when it can).
 *
 * One lexer pass MASKS the text: comments become spaces and every string,
 * char and regex literal becomes `~`, keeping each newline where it was. A
 * line then holds code exactly when its masked text holds a non-space, and a
 * brace or paren in the masked text is always real syntax, so function bodies
 * can be found by plain bracket matching.
 *
 *   Go    line and block comments; "…" with escapes; `raw` strings (multi-line);
 *         'r' runes.
 *   Rust  line comments (doc comments too) and block comments, which nest;
 *         "…", b"…", c"…" (escapes, multi-line); r"…", r#"…"#, br##"…"## raw
 *         strings; 'c' and b'c' chars, told from a lifetime or loop label
 *         ('a, 'outer:) by the quote that closes a char.
 *   JS    line and block comments; '…' and "…"; template literals with nested
 *         ${…}; a regex literal wherever an operand may start (after an
 *         operator, an opening bracket, a comma or a keyword like `return`).
 *         Approximate: no function sizes, and a regex after `)` reads as
 *         division.
 *
 * Functions (Go and Rust): `func`/`fn`, its signature, and the body its `{`
 * opens at bracket depth 0. A function's OWN lines run from its keyword to
 * its closing brace and exclude the functions nested in it (Go func literals,
 * Rust inner fns), which count for themselves;
 * Rust closures belong to the fn they are written in.
 */

const MASK = "~";
const IDENT = /[A-Za-z0-9_]/;
const JS_REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const JS_REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** The masked text and the 1-based lines that hold code. */
export function lexBraceLanguage(text, dialect) {
	const m = text.split("");
	const n = text.length;
	const fill = (from, to, ch) => {
		for (let k = from; k < to; k++) if (m[k] !== "\n" && m[k] !== "\r") m[k] = ch;
	};
	const templates = []; // JS: the brace depth each open `${` returns to
	let braces = 0;
	let prev = ""; // JS: the last significant char, or "w:<word>" after a word
	let i = 0;
	const resumeTemplate = (from) => {
		const end = templateEnd(text, from);
		fill(from, end.at, MASK);
		if (end.interpolation) { templates.push(braces); braces += 1; prev = "{"; return end.at + 2; }
		prev = "a";
		return end.at + 1;
	};
	while (i < n) {
		const c = text[i];
		const d = text[i + 1];
		if (c === "/" && d === "/") {
			let j = text.indexOf("\n", i);
			if (j < 0) j = n;
			fill(i, j, " ");
			i = j;
			continue;
		}
		if (c === "/" && d === "*") {
			const j = blockCommentEnd(text, i, dialect === "rust");
			fill(i, j, " ");
			i = j;
			continue;
		}
		const end = literalEnd(text, i, dialect, prev);
		if (end > i) {
			fill(i, end, MASK);
			i = end;
			prev = "a";
			continue;
		}
		if (dialect === "js" && c === "`") { i = resumeTemplate(i + 1); continue; }
		if (dialect === "js") {
			if (c === "{") braces += 1;
			if (c === "}") {
				braces -= 1;
				if (templates.length && braces === templates[templates.length - 1]) {
					templates.pop();
					i = resumeTemplate(i + 1);
					continue;
				}
			}
			if (IDENT.test(c)) {
				let j = i;
				while (j < n && IDENT.test(text[j])) j++;
				prev = `w:${text.slice(i, j)}`;
				i = j;
				continue;
			}
			if (!/\s/.test(c)) prev = c;
		}
		i += 1;
	}
	const masked = m.join("");
	const codeLines = new Set();
	masked.split("\n").forEach((line, k) => { if (/\S/.test(line)) codeLines.add(k + 1); });
	return { masked, codeLines };
}

/** Where a template literal's text ends: at the closing backtick, or at a `${`. */
function templateEnd(text, from) {
	for (let j = from; j < text.length; j++) {
		if (text[j] === "\\") { j++; continue; }
		if (text[j] === "`") return { at: j, interpolation: false };
		if (text[j] === "$" && text[j + 1] === "{") return { at: j, interpolation: true };
	}
	return { at: text.length, interpolation: false };
}

function blockCommentEnd(text, i, nests) {
	let depth = 0;
	for (let j = i; j < text.length - 1; j++) {
		if (text[j] === "/" && text[j + 1] === "*" && (nests || depth === 0)) { depth += 1; j++; continue; }
		if (text[j] === "*" && text[j + 1] === "/") {
			depth -= 1;
			j++;
			if (depth === 0) return j + 1;
		}
	}
	return text.length;
}

/** End (exclusive) of a quoted literal starting at i, honouring backslash
 *  escapes; a single-line literal ends at an unescaped newline. */
function quotedEnd(text, i, quote, multiLine) {
	for (let j = i + 1; j < text.length; j++) {
		if (text[j] === "\\") { j++; continue; }
		if (text[j] === quote) return j + 1;
		if (text[j] === "\n" && !multiLine) return j;
	}
	return text.length;
}

/** End of the string/char/regex literal starting at i, or -1 when none does. */
function literalEnd(text, i, dialect, prev) {
	const c = text[i];
	if (dialect === "go") {
		if (c === '"') return quotedEnd(text, i, '"', false);
		if (c === "'") return quotedEnd(text, i, "'", false);
		if (c === "`") {
			const j = text.indexOf("`", i + 1);
			return j < 0 ? text.length : j + 1;
		}
		return -1;
	}
	if (dialect === "rust") return rustLiteralEnd(text, i);
	if (c === '"' || c === "'") return quotedEnd(text, i, c, false);
	if (c === "/" && regexMayStart(prev)) return regexEnd(text, i);
	return -1;
}

function regexMayStart(prev) {
	if (prev === "") return true;
	if (prev.startsWith("w:")) return JS_REGEX_KEYWORDS.has(prev.slice(2));
	return JS_REGEX_AFTER.has(prev);
}

/** A regex literal's end, flags excluded (they are code either way); -1 when
 *  the line ends first, which means the slash was division. */
function regexEnd(text, i) {
	let inClass = false;
	for (let j = i + 1; j < text.length; j++) {
		const c = text[j];
		if (c === "\n") return -1;
		if (c === "\\") { j++; continue; }
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return j + 1;
	}
	return -1;
}

function rustLiteralEnd(text, i) {
	const c = text[i];
	if (i > 0 && IDENT.test(text[i - 1]) && c !== '"' && c !== "'") return -1;
	let j = i;
	if (c === "b" || c === "c") j += 1;
	if (text[j] === "r" && (text[j + 1] === '"' || text[j + 1] === "#")) {
		let k = j + 1;
		while (text[k] === "#") k++;
		if (text[k] !== '"') return -1; // r#ident, a raw identifier
		const close = '"' + "#".repeat(k - j - 1);
		const at = text.indexOf(close, k + 1);
		return at < 0 ? text.length : at + close.length;
	}
	if (text[j] === '"') return quotedEnd(text, j, '"', true);
	if (text[j] === "'" && (j === i + 1 ? c === "b" : true)) return rustCharEnd(text, j);
	return -1;
}

/** A char literal's end, or -1 for a lifetime or label ('a, 'static, 'outer:). */
function rustCharEnd(text, j) {
	if (text[j + 1] === "\\") {
		const close = text.indexOf("'", j + 3);
		return close < 0 ? -1 : close + 1;
	}
	const cp = text.codePointAt(j + 1);
	if (cp === undefined || text[j + 1] === "'" || text[j + 1] === "\n") return -1;
	const width = cp > 0xffff ? 2 : 1;
	return text[j + 1 + width] === "'" ? j + 2 + width : -1;
}

// ── Function bodies ─────────────────────────────────────────────────────────

/** Index of the bracket that closes the one at `open`, in masked text. */
function matchClose(masked, open) {
	let depth = 0;
	for (let k = open; k < masked.length; k++) {
		const ch = masked[k];
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth -= 1;
			if (depth === 0) return k;
		}
	}
	return masked.length - 1;
}

const ITEM_START = /(^|[{};\]]|\bpub(\([^)]*\))?|\bunsafe|\bdefault)\s*$/;
const skipSpace = (s, k) => { while (k < s.length && /\s/.test(s[k])) k++; return k; };
const wordAt = (s, k) => { const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(k, k + 200)); return w ? w[0] : ""; };

/** Go: after the parameters, the `{` that opens the body (same line, depth 0,
 *  past `interface{}` / `struct{…}` result types), or -1 for a func type. */
function goBodyOpen(masked, k) {
	while (k < masked.length) {
		const ch = masked[k];
		if (ch === "\n" || ch === ")" || ch === "," || ch === ";" || ch === "=" || ch === "}") return -1;
		if (ch === "(" || ch === "[") { k = matchClose(masked, k) + 1; continue; }
		if (ch === "{") {
			if (/\b(interface|struct)\s*$/.test(masked.slice(Math.max(0, k - 20), k))) { k = matchClose(masked, k) + 1; continue; }
			return k;
		}
		k += 1;
	}
	return -1;
}

function goFunctions(masked, text) {
	const out = [];
	let skipUntil = -1;
	for (const hit of masked.matchAll(/\bfunc\b/g)) {
		if (hit.index < skipUntil) continue; // a func type inside another signature
		let k = skipSpace(masked, hit.index + 4);
		let name = null;
		if (masked[k] === "(") {
			const close = matchClose(masked, k);
			const after = skipSpace(masked, close + 1);
			const method = wordAt(masked, after);
			if (method && /^[([]/.test(masked[skipSpace(masked, after + method.length)])) {
				const recv = text.slice(k + 1, close).trim().split(/\s+/).pop().replace(/^\*/, "").replace(/\[.*$/, "");
				name = `${recv}.${method}`;
				k = skipSpace(masked, after + method.length);
			}
		} else {
			name = wordAt(masked, k);
			if (!name) continue;
			k = skipSpace(masked, k + name.length);
		}
		if (masked[k] === "[") k = skipSpace(masked, matchClose(masked, k) + 1);
		if (masked[k] !== "(") continue;
		const open = goBodyOpen(masked, matchClose(masked, k) + 1);
		if (open < 0) continue;
		skipUntil = open;
		out.push({ name, start: hit.index, end: matchClose(masked, open) });
	}
	// Literals take Go's own names: the enclosing named func, then func1, func2, ...
	const counters = new Map();
	for (const f of out) {
		if (f.name) continue;
		const outer = out.find((g) => g.name && g.start < f.start && f.end <= g.end)?.name ?? "glob";
		counters.set(outer, (counters.get(outer) ?? 0) + 1);
		f.name = `${outer}.func${counters.get(outer)}`;
	}
	return out;
}

/** Rust: `impl …` / `trait …` blocks, so a method is named `Type::method`. */
function rustOwners(masked, text) {
	const out = [];
	for (const hit of masked.matchAll(/\b(impl|trait)\b/g)) {
		// An item, not `-> impl Trait` or `x: impl Fn()` inside a signature.
		if (!ITEM_START.test(masked.slice(Math.max(0, hit.index - 40), hit.index))) continue;
		let k = hit.index + hit[0].length;
		while (k < masked.length && masked[k] !== "{" && masked[k] !== ";") k++;
		if (masked[k] !== "{") continue;
		let header = text.slice(hit.index + hit[0].length, k).replace(/\bwhere\b[\s\S]*$/, "").trim();
		if (hit[1] === "impl") header = header.replace(/^<[^>]*(<[^>]*>[^>]*)*>/, "").trim();
		const forAt = header.search(/\bfor\b/);
		if (forAt >= 0) header = header.slice(forAt + 3).trim();
		const type = /^(?:dyn\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(header.replace(/^.*::/, ""))?.[1];
		if (type) out.push({ type, start: k, end: matchClose(masked, k) });
	}
	return out;
}

function rustFunctions(masked, text) {
	const owners = rustOwners(masked, text);
	const out = [];
	for (const hit of masked.matchAll(/\bfn\b/g)) {
		let k = skipSpace(masked, hit.index + 2);
		const name = wordAt(masked, k);
		if (!name) continue; // an `fn(…)` pointer type
		k = skipSpace(masked, k + name.length);
		if (masked[k] === "<") {
			let depth = 0;
			for (; k < masked.length; k++) {
				if (masked[k] === "<") depth += 1;
				else if (masked[k] === ">" && masked[k - 1] !== "-" && --depth === 0) break;
			}
			k = skipSpace(masked, k + 1);
		}
		if (masked[k] !== "(") continue;
		k = matchClose(masked, k) + 1;
		while (k < masked.length && masked[k] !== "{" && masked[k] !== ";" && masked[k] !== "}") {
			k = masked[k] === "(" || masked[k] === "[" ? matchClose(masked, k) + 1 : k + 1;
		}
		if (masked[k] !== "{") continue; // a trait method with no default body
		const owner = owners.filter((o) => o.start < hit.index && hit.index < o.end).pop();
		out.push({ name, owner: owner?.type, start: hit.index, end: matchClose(masked, k) });
	}
	// A method is `Type::name`; an fn inside another fn keeps its bare name.
	for (const f of out) {
		const inFn = out.some((g) => g !== f && g.start < f.start && f.end <= g.end);
		if (f.owner && !inFn) f.name = `${f.owner}::${f.name}`;
	}
	return out;
}

/** Each function's own code lines: the non-space masked chars from its
 *  keyword to its closing brace, minus the functions nested inside it. */
function ownLines(masked, fns) {
	const lineStarts = [0];
	for (let k = 0; k < masked.length; k++) if (masked[k] === "\n") lineStarts.push(k + 1);
	const lineOf = (pos) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
		}
		return lo + 1;
	};
	return fns.map((f) => {
		const nested = fns.filter((g) => g !== f && f.start < g.start && g.end <= f.end).sort((a, b) => a.start - b.start);
		const own = new Set();
		let k = f.start;
		for (const g of nested) {
			if (g.start < k) continue;
			for (; k < g.start; k++) if (!/\s/.test(masked[k])) own.add(lineOf(k));
			k = g.end + 1;
		}
		for (; k <= f.end; k++) if (!/\s/.test(masked[k])) own.add(lineOf(k));
		return { name: f.name, line: lineOf(f.start), code: own.size };
	});
}

/** Code lines and (Go, Rust) function sizes; `functions` is null for JS. */
export function measureBraceLanguage(text, dialect) {
	const { masked, codeLines } = lexBraceLanguage(text, dialect);
	if (dialect === "js") return { code: codeLines.size, functions: null };
	const fns = dialect === "go" ? goFunctions(masked, text) : rustFunctions(masked, text);
	return { code: codeLines.size, functions: ownLines(masked, fns) };
}
