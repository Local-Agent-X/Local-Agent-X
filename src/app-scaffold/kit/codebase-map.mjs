#!/usr/bin/env node
/**
 * Generated structural map of a source tree, for humans and AI agents.
 *
 * Facts that drift (who imports what, which modules are dead, which files are
 * oversized) are computed from the tree instead of hand-written in docs.
 * Resolves static AND dynamic imports — a plain grep for "from" misses
 * `import("./x.js")` and mislabels live modules as dead.
 *
 * Languages, what a module is and how imports resolve: project-languages.mjs
 * (JS/TS, Python, Rust, Go). The default source roots come from the project
 * file at the repo root (Cargo.toml → src; go.mod → internal/, cmd/, pkg/;
 * otherwise src); --root overrides them and may repeat.
 *
 * Usage:
 *   node codebase-map.mjs                      write the map
 *   node codebase-map.mjs --check              exit 1 if the map is stale (wire into build)
 *   node codebase-map.mjs --deps <path>        who imports <path>, and what it imports
 *   node codebase-map.mjs --deps <path> --depth N
 *                                              who a change reaches, hop by hop, and the tests to run
 * Options:
 *   --root <dir>      source root (repeatable; default: the project kind's roots)
 *   --out <file>      output markdown (default: docs/codebase-map.md)
 *   --max-code <n> --warn-code <n> --max-fn <n> --warn-fn <n>
 *                     the size caps, in code lines (code-size.mjs; defaults 400 / 320 / 100 / 60):
 *                     what is over them is listed as oversized, what is in the warning band as nearing
 *   --entry <module>  module reached at runtime, not by import (repeatable; `auth` or `src/auth`)
 *
 * The output only changes on events worth reviewing — a module added or
 * removed, a new cross-module dependency or cycle, an importer count change, a
 * module going dead, a file or function crossing a size cap or moving ten code
 * lines within the warning band, a size-tier flip — so
 * --check can gate the build without failing on trivial edits.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { defaultRoots, importContext, importTargets, isTestPath, moduleOf, walkSource } from "./project-languages.mjs";
import { bandOf, limitsFromArgs, measureSource, nearingSection, sizeItems } from "./code-size.mjs";
import { applyTypeScriptFlag } from "./typescript-api.mjs";

const args = process.argv.slice(2);
applyTypeScriptFlag(args);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const optAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const REPO = process.cwd();
const ROOTS = (optAll("--root").length ? optAll("--root") : defaultRoots(REPO)).map((r) => resolve(REPO, r));
const OUT = resolve(REPO, opt("--out", "docs/codebase-map.md"));
const LIMITS = limitsFromArgs(args);
const ENTRIES = new Set(optAll("--entry"));
const CHECK = args.includes("--check");
const DEPS = opt("--deps", null);

const posix = (p) => relative(REPO, p).split(sep).join("/");
const isTest = (p) => isTestPath(posix(p));
const LOOSE = "(root files)";

// A project before its first source file has an empty tree, not a broken one.
const rootOf = new Map(); // file -> its source root
for (const root of ROOTS) if (existsSync(root)) for (const f of walkSource(root)) rootOf.set(f, root);
const files = [...rootOf.keys()];
const display = new Map(); // module key -> the path a doc names (`src/auth/`, `src/auth.rs`)
const unitOf = (f) => {
	const m = moduleOf(f, rootOf.get(f), REPO);
	if (!m) return LOOSE;
	if (!display.has(m.key) || m.display.endsWith("/")) display.set(m.key, m.display);
	return m.key;
};
const isEntry = (key) => ENTRIES.has(key) || ENTRIES.has(key.split("/").pop());

const sizeItemsOf = (file) => sizeItems(posix(file), measureSource(file, readFileSync(file, "utf8"), REPO));
const tier = (loc) => (loc < 250 ? "S" : loc < 1000 ? "M" : loc < 3000 ? "L" : "XL");

const prod = files.filter((f) => !isTest(f));
const inTree = new Set(files);
const ctx = importContext(REPO, ROOTS);
const allEdges = new Map(); // file -> Set(target files inside the mapped tree), tests included
for (const f of files) allEdges.set(f, new Set(importTargets(f, ctx).filter((t) => t !== f && inTree.has(t))));
const edges = new Map(prod.map((f) => [f, allEdges.get(f)])); // the wiring: non-test files only

if (DEPS) {
	// --depth N: hop 1 imports the target, hop 2 imports a hop-1 file, ...; then
	// every test that imports the target or a reached file: the tests to run.
	const DEPTH = Number(opt("--depth", "1"));
	const target = resolve(REPO, DEPS);
	const inside = (p) => p === target || p.startsWith(target + sep);
	const importersOf = new Map();
	for (const [f, ts] of allEdges) for (const t of ts) (importersOf.get(t) ?? importersOf.set(t, new Set()).get(t)).add(f);
	const seen = new Set(files.filter(inside));
	const reached = [...seen];
	let frontier = [...seen];
	const hops = [];
	for (let hop = 1; hop <= DEPTH && frontier.length; hop++) {
		const next = [];
		for (const f of frontier) for (const i of importersOf.get(f) ?? []) if (!seen.has(i) && !isTest(i)) { seen.add(i); next.push(i); }
		hops.push(next);
		reached.push(...next);
		frontier = next;
	}
	const tests = [...new Set(reached.flatMap((f) => [...(importersOf.get(f) ?? [])].filter(isTest)))].map(posix).sort();
	const grouped = (list) => {
		const m = new Map();
		for (const f of list) (m.get(unitOf(f)) ?? m.set(unitOf(f), new Set()).get(unitOf(f))).add(posix(f));
		return m;
	};
	const print = (title, m) => {
		const total = [...m.values()].reduce((n, s) => n + s.size, 0);
		console.log(`\n## ${title} (${total} files across ${m.size} modules)`);
		for (const [unit, s] of [...m].sort((a, b) => b[1].size - a[1].size)) {
			console.log(`\n${display.get(unit) ?? unit} (${s.size})`);
			for (const p of [...s].sort()) console.log(`  ${p}`);
		}
	};
	console.log(`# Dependencies of ${relative(REPO, target)} (non-test, static + dynamic imports)`);
	hops.forEach((list, i) => print(i === 0 ? "Imported by" : `Reached at hop ${i + 1} (imports a hop-${i} file)`, grouped(list)));
	if (DEPTH === 1) print("Imports from", grouped([...new Set(files.filter((f) => inside(f) && !isTest(f)).flatMap((f) => [...allEdges.get(f)]).filter((t) => !inside(t)))]));
	console.log(`\n## Tests to run: every test that imports it or a file listed above (${tests.length})`);
	for (const t of tests) console.log(`  ${t}`);
	process.exit(0);
}

const units = new Map();
const sized = []; // every non-test file and function, measured in code lines
for (const f of files) {
	const u = unitOf(f);
	if (!units.has(u)) units.set(u, { files: 0, loc: 0, oversized: [], importers: new Set(), dependsOn: new Set() });
	if (isTest(f)) continue;
	const rec = units.get(u);
	const items = sizeItemsOf(f);
	sized.push(...items);
	rec.files += 1;
	rec.loc += items[0].size;
	rec.oversized.push(...items.filter((it) => bandOf(it, LIMITS) === "over").map((it) => it.key));
}
for (const [f, ts] of edges) {
	const from = unitOf(f);
	for (const t of ts) {
		const to = unitOf(t);
		if (to === from) continue;
		units.get(to).importers.add(posix(f));
		if (to !== LOOSE) units.get(from).dependsOn.add(to);
	}
}
for (const [u, rec] of units) if (rec.files === 0) units.delete(u);

const rows = [...units].filter(([u]) => u !== LOOSE).sort((a, b) => b[1].importers.size - a[1].importers.size || a[0].localeCompare(b[0]));
const name = (u) => `\`${display.get(u) ?? u}\``;

// Module cycles: groups of modules that each reach the others through imports
// (strongly connected components of the module graph, Tarjan). Two modules in
// one cycle can't be understood, tested or changed apart — the coupling an
// agent breaks without seeing it. Listed so a new cycle is a reviewed event.
function moduleCycles() {
	const graph = new Map(rows.map(([u, r]) => [u, [...r.dependsOn].filter((d) => units.has(d))]));
	let next = 0;
	const index = new Map();
	const low = new Map();
	const stack = [];
	const onStack = new Set();
	const out = [];
	const visit = (v) => {
		index.set(v, next);
		low.set(v, next++);
		stack.push(v);
		onStack.add(v);
		for (const w of graph.get(v) ?? []) {
			if (!index.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v), low.get(w)));
			} else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
		}
		if (low.get(v) !== index.get(v)) return;
		const group = [];
		let w;
		do {
			w = stack.pop();
			onStack.delete(w);
			group.push(w);
		} while (w !== v);
		if (group.length > 1) out.push(group.sort());
	};
	for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
	return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}
const cycles = moduleCycles();
const dead = rows.filter(([u, r]) => r.importers.size === 0 && !isEntry(u));
const oversized = [...units.values()].flatMap((r) => r.oversized).sort();
const nearing = nearingSection(sized, LIMITS);
const loose = units.get(LOOSE)?.files ?? 0;
const rootsRel = ROOTS.map((r) => `\`${posix(r)}/\``).join(", ");

const lines = [
	"# Codebase map (generated — do not edit)",
	"",
	`Regenerate with the map script; the build fails when this file is stale. Source root${ROOTS.length > 1 ? "s" : ""}: ${rootsRel}.`,
	"This file owns the facts that drift. ARCHITECTURE.md owns the meaning.",
	"",
	`**Definitions** — *Importers*: distinct non-test files outside the module that import it (static or dynamic). ` +
		`*Size*: S <250 · M <1k · L <3k · XL ≥3k non-test code lines (comments and blank lines are free). ` +
		`*Oversized*: non-test files over ${LIMITS.maxCode} code lines, and functions (\`file#function\`) over ${LIMITS.maxFn} of their own.`,
	"",
	`**Totals:** ${rows.length} modules · ${dead.length} with no importer · ${prod.length} non-test source files · ` +
		`${loose} loose files at the source root · ${oversized.length} oversized · ${nearing.length} nearing the size cap.`,
	"",
	"## Modules",
	"",
	"| Module | Importers | Files | Size | Oversized |",
	"|---|--:|--:|:--:|--:|",
	...rows.map(([u, r]) => `| ${name(u)}${isEntry(u) ? " *(entrypoint)*" : ""} | ${r.importers.size} | ${r.files} | ${tier(r.loc)} | ${r.oversized.length || ""} |`),
	"",
	"## Module dependencies",
	"",
	"Which modules each module imports from. A new entry here is a new coupling — review it.",
	"",
	"| Module | Depends on |",
	"|---|---|",
	...rows.map(([u, r]) => `| ${name(u)} | ${[...r.dependsOn].sort().map(name).join(", ") || "—"} |`),
	"",
	"## Module cycles",
	"",
	"Modules that reach each other through imports. They can't be changed or tested apart; break a new cycle rather than extend it.",
	"",
	cycles.length ? cycles.map((g) => `- ${g.map(name).join(" ⇄ ")}`).join("\n") : "None.",
	"",
	"## No live importer",
	"",
	dead.length ? dead.map(([u]) => `- ${name(u)} — dead, or reached at runtime (then pass \`--entry ${u}\`)`).join("\n") : "None.",
	"",
	"## Oversized",
	"",
	"Over a size cap: the size check fails unless its ratchet lists them at their recorded size.",
	"",
	oversized.length ? oversized.map((p) => `- \`${p}\``).join("\n") : "None.",
	"",
	"## Nearing the size cap",
	"",
	`In the warning band (a file over ${LIMITS.warnCode} code lines, a function over ${LIMITS.warnFn}), largest first. ` +
		"Before adding to one, find the job that grew and move it to a module named after that job; comments are free, so never cut them to fit.",
	"",
	nearing.length ? nearing.join("\n") : "None.",
	"",
];
const output = lines.join("\n");

if (CHECK) {
	const current = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
	if (current !== output) {
		console.error(`${relative(REPO, OUT)} is stale — regenerate it with the codebase map script and commit the result.`);
		process.exit(1);
	}
	console.log(`${relative(REPO, OUT)} is current.`);
} else {
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, output);
	console.log(`wrote ${relative(REPO, OUT)} (${rows.length} modules, ${dead.length} dead, ${cycles.length} cycles, ${oversized.length} oversized, ${nearing.length} nearing the size cap)`);
}
