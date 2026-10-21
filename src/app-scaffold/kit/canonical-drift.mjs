/**
 * Canonical drift: one job implemented in two places, found by name.
 *
 * In a repo with several source roots (apps/web/src, apps/mobile,
 * packages/shared/src, supabase/functions …) the same function or type gets
 * written again in a second root, because an import across roots is awkward
 * or the author never saw the first one. The copies then drift: one app parses
 * a height one way, the other another way. code-refs.mjs --duplicates can't
 * see this (it reads one TypeScript project), and the import graph shows
 * nothing, because the copy imports nothing.
 *
 * Two findings, both keyed by name and by the set of roots it appears in:
 *   shadow     a name a CANONICAL root exports (--canonical: the shared
 *              package) declared again in another root, exported or not. The
 *              copy should be an import.
 *   duplicate  a name exported from two or more non-canonical roots. One of
 *              them should own it, usually by moving it to the canonical root.
 * Same-root repeats are not drift (two files in one project: refs --duplicates).
 *
 * Also collected, report only: comments that admit a copy ("mirrors X",
 * "same as", "copy of", "keep in sync"). Each one is a coupling someone wrote
 * down instead of testing.
 *
 * Declarations are read line-anchored per language (project-languages.mjs
 * decides which files are source and which are tests; tests never count):
 *   JS/TS   `export [default] [async] function|const|let|var|class|interface|type|enum Name`;
 *           local (for shadows): the same at column 0 without `export`. Re-exports
 *           (`export { x } from`) are imports, not copies, and never count.
 *   Python  top-level `def` / `class` / UPPER_CASE constants; `_private` is local only.
 *   Go      top-level `func Name(` (no receiver), `type|var|const Name`; exported = Capitalized.
 *   Rust    `pub fn|struct|enum|trait|type|const|static|union name`; local without `pub`.
 * check-canonical.mjs is the gate; codebase-map.mjs lists the findings.
 */
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { isTestPath, languageOf, walkSource } from "./project-languages.mjs";

const JS_KIND = "(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum)\\s+([A-Za-z_$][\\w$]*)";
const RS_KIND = "(?:async\\s+)?(?:unsafe\\s+)?(?:fn|struct|enum|trait|type|const|static|union)\\s+(\\w+)";

const DECLARATIONS = {
	js: {
		exported: new RegExp(`^export\\s+(?:default\\s+)?${JS_KIND}`, "gm"),
		local: new RegExp(`^${JS_KIND}`, "gm"),
	},
	python: {
		exported: /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)|^([A-Z][A-Z0-9_]*)\s*[:=]/gm,
		local: /^(?:async\s+)?(?:def|class)\s+(\w+)|^([A-Z][A-Z0-9_]*)\s*[:=]/gm,
	},
	go: {
		exported: /^func\s+([A-Z]\w*)\s*[([]|^(?:type|var|const)\s+([A-Z]\w*)/gm,
		local: /^func\s+(\w+)\s*[([]|^(?:type|var|const)\s+(\w+)/gm,
	},
	rust: {
		exported: new RegExp(`^pub(?:\\([^)]*\\))?\\s+${RS_KIND}`, "gm"),
		local: new RegExp(`^${RS_KIND}`, "gm"),
	},
};

// A comment line (//, /* or * continuation, #, --) that says one place copies another.
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|#(?!!)|--)/;
const MIRROR_PHRASE = /\b(?:mirror(?:s|ed|ing)?\b|same as\b|cop(?:y|ied) (?:of|from)\b|kept? in sync\b|duplicated? (?:of|from)\b)/i;

const namesIn = (text, re) => [...text.matchAll(re)].map((m) => m[1] ?? m[2]).filter(Boolean);

/**
 * Read every non-test source file under the roots.
 *   repo       absolute repo path; roots: absolute source roots
 *   exclude    RegExps tested against the repo-relative path (generated files)
 * Returns { exported, local, mirrors } where exported/local map
 * name → Map(rootRel → Set(fileRel)) and mirrors lists { file, line, text }.
 */
export function scanDeclarations(repo, roots, { exclude = [] } = {}) {
	const rel = (p) => relative(repo, p).split(sep).join("/");
	const exported = new Map();
	const local = new Map();
	const mirrors = [];
	const add = (map, name, root, file) => {
		const byRoot = map.get(name) ?? map.set(name, new Map()).get(name);
		(byRoot.get(root) ?? byRoot.set(root, new Set()).get(root)).add(file);
	};
	for (const root of roots) {
		const rootRel = rel(root);
		for (const f of walkSource(root)) {
			const file = rel(f);
			if (isTestPath(file) || exclude.some((re) => re.test(file))) continue;
			const decl = DECLARATIONS[languageOf(f)?.id];
			if (!decl) continue;
			const text = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
			for (const n of namesIn(text, decl.exported)) add(exported, n, rootRel, file);
			for (const n of namesIn(text, decl.local)) add(local, n, rootRel, file);
			text.split("\n").forEach((line, i) => {
				if (COMMENT_LINE.test(line) && MIRROR_PHRASE.test(line)) mirrors.push({ file, line: i + 1, text: line.trim().slice(0, 140) });
			});
		}
	}
	return { exported, local, mirrors };
}

/**
 * The drift findings, sorted by name: { name, kind, roots, files }.
 * `roots` is the sorted list of roots the name appears in (its identity in a
 * ratchet); `files` the files that declare it. canonicalRoots are repo-relative.
 */
export function driftFindings(scan, canonicalRoots = []) {
	const canonical = new Set(canonicalRoots);
	const findings = [];
	const names = new Set([...scan.exported.keys()]);
	for (const name of [...names].sort()) {
		const exp = scan.exported.get(name);
		const owner = [...exp.keys()].find((r) => canonical.has(r));
		if (owner) {
			// Shadow: any declaration of the name outside the canonical root.
			const copies = new Map([...(scan.local.get(name) ?? new Map())].filter(([r]) => !canonical.has(r)));
			for (const [r, fs] of exp) if (!canonical.has(r)) copies.set(r, new Set([...(copies.get(r) ?? []), ...fs]));
			if (!copies.size) continue;
			const roots = [owner, ...copies.keys()].sort();
			const files = [...exp.get(owner), ...[...copies.values()].flatMap((s) => [...s])].sort();
			findings.push({ name, kind: "shadow", canonical: owner, roots, files });
		} else if (exp.size > 1) {
			findings.push({ name, kind: "duplicate", roots: [...exp.keys()].sort(), files: [...exp.values()].flatMap((s) => [...s]).sort() });
		}
	}
	return findings;
}

/** Map lines for the drift findings and the mirror comments; stable under
 *  ordinary edits (no line numbers), so the map's --check only trips on a
 *  finding or a mirroring file appearing or going away. */
export function driftSection(findings, mirrors) {
	const shadows = findings.filter((f) => f.kind === "shadow");
	const dups = findings.filter((f) => f.kind === "duplicate");
	const row = (f) => `- \`${f.name}\` — ${f.roots.map((r) => `\`${r}/\``).join(", ")}`;
	const perFile = new Map();
	for (const m of mirrors) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
	return [
		"## Declared in more than one root",
		"",
		"The same name declared in two source roots is usually one job implemented twice. A *shadow* re-declares a name the canonical " +
			"root exports (it should be an import); a *duplicate* is exported from two other roots (one of them should own it). " +
			"check-canonical fails on a new one.",
		"",
		...(shadows.length ? ["**Shadows of the canonical root:**", "", ...shadows.map(row), ""] : []),
		...(dups.length ? ["**Exported from more than one root:**", "", ...dups.map(row), ""] : []),
		...(findings.length ? [] : ["None.", ""]),
		"## Comments that say one place copies another",
		"",
		"\"Mirrors X\", \"same as\", \"keep in sync\": a coupling written down instead of tested. Each is a candidate for a shared module or a test.",
		"",
		perFile.size ? [...perFile].sort((a, b) => a[0].localeCompare(b[0])).map(([f, n]) => `- \`${f}\`${n > 1 ? ` (${n})` : ""}`).join("\n") : "None.",
		"",
	];
}
