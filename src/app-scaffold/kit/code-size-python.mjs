/**
 * Code lines and function sizes for Python, read with a tokenizer written
 * here rather than Python's own (the kit runs under Node, and the `python` on
 * PATH may not be the project's).
 *
 * The scan follows the language's lexical rules: `#` comments; string literals
 * with any prefix (r, b, u, f and pairs), single or triple quoted, with
 * backslash escapes (a raw string's backslash still keeps its quote from
 * closing it); bracket depth; backslash line continuation. Tokens are grouped
 * into LOGICAL lines, as Python does. A logical line made only of string
 * literals (a docstring, or a bare string used as a comment) is a comment
 * here: it does nothing at runtime, so it is free. Every other logical line
 * counts each physical line it has a token on.
 *
 * Functions are `def` / `async def`; a function's body is the logical lines
 * indented deeper than its `def`, so its OWN lines are its `def` (signature
 * included) plus those, minus the functions defined inside it (they count
 * for themselves). Names are qualified by the enclosing classes and functions
 * (`Store.save`, `build.render`). Known gap: Python 3.12 f-strings that reuse
 * their own quote inside a replacement field (`f"{d["k"]}"`) end early.
 */

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT = /[A-Za-z0-9_\u0080-￿]/;
const STRING_PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;

/** Visual width of leading whitespace, tabs to the next multiple of 8. */
function indentWidth(lead) {
	let w = 0;
	for (const ch of lead) w = ch === "\t" ? (Math.floor(w / 8) + 1) * 8 : w + 1;
	return w;
}

/** End (exclusive) of the string whose opening quote is at `q`. */
function stringEnd(text, q) {
	const quote = text[q];
	const triple = text.startsWith(quote.repeat(3), q);
	for (let j = q + (triple ? 3 : 1); j < text.length; j++) {
		if (text[j] === "\\") { j++; continue; }
		if (triple ? text.startsWith(quote.repeat(3), j) : text[j] === quote) return j + (triple ? 3 : 1);
		if (!triple && text[j] === "\n") return j;
	}
	return text.length;
}

/** The logical lines: first physical line, indent, the physical lines with a
 *  token, whether every token is a string, and the first words. */
function logicalLines(text) {
	const out = [];
	let cur = null;
	let line = 1;
	let lineStart = 0;
	let depth = 0;
	const touch = (from, to) => { for (let l = from; l <= to; l++) cur.lines.add(l); };
	const begin = (i) => {
		if (!cur) cur = { first: line, indent: indentWidth(text.slice(lineStart, i)), lines: new Set(), onlyStrings: true, words: [] };
	};
	const end = () => { if (cur) out.push(cur); cur = null; };
	for (let i = 0; i < text.length;) {
		const c = text[i];
		if (c === "\n") {
			line += 1;
			lineStart = i + 1;
			i += 1;
			if (depth === 0) end();
			continue;
		}
		if (c === " " || c === "\t" || c === "\r" || c === "\f") { i += 1; continue; }
		if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
		if (c === "\\" && (text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))) {
			i = text.indexOf("\n", i) + 1;
			line += 1;
			lineStart = i;
			continue;
		}
		begin(i);
		let q = -1;
		if (c === '"' || c === "'") q = i;
		else if (IDENT_START.test(c)) {
			let j = i;
			while (j < text.length && IDENT.test(text[j])) j++;
			const word = text.slice(i, j);
			if ((text[j] === '"' || text[j] === "'") && STRING_PREFIX.test(word)) q = j;
			else {
				if (cur.words.length < 3) cur.words.push(word);
				cur.onlyStrings = false;
				touch(line, line);
				i = j;
				continue;
			}
		}
		if (q >= 0) {
			const stop = stringEnd(text, q);
			const startLine = line;
			for (let k = i; k < stop; k++) if (text[k] === "\n") { line += 1; lineStart = k + 1; }
			touch(startLine, line);
			i = stop;
			continue;
		}
		if ("([{".includes(c)) depth += 1;
		else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
		cur.onlyStrings = false;
		touch(line, line);
		i += 1;
	}
	end();
	return out;
}

/** Code lines and the own size of every def. */
export function measurePython(text) {
	const code = new Set();
	const functions = [];
	const scopes = []; // { indent, kind: "def" | "class", name, own: Set, line }
	const close = () => {
		const s = scopes.pop();
		if (s.kind === "def") functions.push({ name: s.qualname, line: s.line, code: s.own.size });
	};
	for (const l of logicalLines(text)) {
		while (scopes.length && l.indent <= scopes[scopes.length - 1].indent) close();
		if (l.onlyStrings) continue;
		for (const n of l.lines) code.add(n);
		const def = [...scopes].reverse().find((s) => s.kind === "def");
		if (def) for (const n of l.lines) def.own.add(n);
		const [w0, w1, w2] = l.words;
		const kind = w0 === "def" || (w0 === "async" && w1 === "def") ? "def" : w0 === "class" ? "class" : null;
		if (!kind) continue;
		const name = w0 === "async" ? w2 : w1;
		if (!name) continue;
		const qualname = [...scopes.map((s) => s.name), name].join(".");
		scopes.push({ indent: l.indent, kind, name, qualname, own: new Set(kind === "def" ? l.lines : []), line: l.first });
	}
	while (scopes.length) close();
	functions.sort((a, b) => a.line - b.line);
	return { code: code.size, functions };
}
