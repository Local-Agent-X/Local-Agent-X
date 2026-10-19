#!/usr/bin/env node
/**
 * Size caps on CODE lines (code-size.mjs: comment and blank lines are free),
 * for files and for functions, with a ratchet for what was already over.
 *
 * Why the caps: an agent finds its way around a repo by reading whole files
 * and whole functions. Past the cap a file or function is almost always doing
 * a second job, so the way back under is to find that job and move it into a
 * module (or function) named after it. Deleting comments never helps (they do
 * not count), and a split named after the limit ("part 2", "under the cap")
 * tells the next reader nothing.
 *
 *   file      code lines over --max-code fail; over --warn-code is a warning.
 *   function  own code lines (nested functions count for themselves) over
 *             --max-fn fail; over --warn-fn is a warning. Measured for TS/JS
 *             (with the project's `typescript`), Python, Go and Rust.
 * The warning band is printed under NEARING_HEADING and never fails.
 *
 * The ratchet (--ratchet, default .code-size-ratchet) lists what was over a
 * cap when the caps were adopted, one item per line with its recorded size:
 *     src/big.ts 412
 *     src/big.ts#Parser.parse 160
 *     src/routes.ts#app.get:callback@88 131
 * (`@line` only when two functions in a file share a name; `#` at the start of
 * a line is a comment). The check fails when a listed item grew past its
 * recorded size, when it shrank and the list was not lowered, when it is back
 * under the cap (or gone) and still listed, and when anything else is over a
 * cap. New projects start with no ratchet file.
 *
 * Usage:
 *   node check-code-size.mjs [--root src]... [--max-code 400] [--warn-code 320]
 *                            [--max-fn 100] [--warn-fn 60] [--ratchet .code-size-ratchet]
 *   ... --write-ratchet   (re)write the ratchet with everything over a cap now (retrofit;
 *                         deterministic: sorted by path, the same tree writes the same file)
 *   ... --tighten         lower recorded sizes to current, drop items back under the cap
 *   ... --self "<cmd>"    how this check is run, for the commands it prints
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bandOf, capOf, limitsFromArgs, measureSource, sizeItems, unitOf } from "./code-size.mjs";
import { defaultRoots, isTestPath, walkSource } from "./project-languages.mjs";

const NEARING_HEADING = "Nearing the size cap (a warning; it never fails):";
const STEERING =
	"Find the job that grew in it and move that job into a module (or function) named after the job. " +
	"Comments and blank lines are free, so never delete comments to fit, and never name the split after the limit.";

/** The warning band is listed largest first, this many at most. */
const NEAR_LISTED = 25;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const REPO = process.cwd();
const ROOTS = args.flatMap((a, i) => (a === "--root" ? [args[i + 1]] : []));
const LIMITS = limitsFromArgs(args);
const RATCHET = resolve(REPO, opt("--ratchet", ".code-size-ratchet"));
const rel = (p) => relative(REPO, p).split(sep).join("/");
const SELF = opt("--self", null)
	?? `node ${rel(fileURLToPath(import.meta.url))} ${args.filter((a, i) => !["--write-ratchet", "--tighten"].includes(a) && args[i - 1] !== "--self").join(" ")}`.trim();

// ── Measure ──────────────────────────────────────────────────────────────────
const files = (ROOTS.length ? ROOTS : defaultRoots(REPO))
	.flatMap((r) => (existsSync(resolve(REPO, r)) ? walkSource(resolve(REPO, r)) : []))
	.filter((f) => !isTestPath(rel(f)));
const items = [];
let approximate = 0;
for (const f of files) {
	const measured = measureSource(f, readFileSync(f, "utf8"), REPO);
	if (measured.approximate) approximate += 1;
	items.push(...sizeItems(rel(f), measured));
}
const over = items.filter((it) => bandOf(it, LIMITS) === "over");
const near = items.filter((it) => bandOf(it, LIMITS) === "near");

// ── Ratchet ──────────────────────────────────────────────────────────────────
const HEADER = [
	"# Code-size ratchet: what was over a cap when the caps were adopted, at its recorded size.",
	"# An item may only shrink. When one shrinks, lower its number (--tighten does it); when it is",
	"# back under the cap, its line goes. Never add a line: move the job that grew into its own module.",
];
const writeRatchet = (entries) => {
	const body = [...HEADER, ...entries.sort((a, b) => a.key.localeCompare(b.key)).map((e) => `${e.key} ${e.size}`), ""].join("\n");
	writeFileSync(RATCHET, body);
};

if (args.includes("--write-ratchet")) {
	writeRatchet(over.map((it) => ({ key: it.key, size: it.size })));
	const fns = over.filter((it) => it.kind === "function").length;
	console.log(`wrote ${rel(RATCHET)}: ${over.length - fns} files and ${fns} functions over the caps`);
	process.exit(0);
}

const entries = existsSync(RATCHET)
	? readFileSync(RATCHET, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
		const at = l.search(/\s+\d+$/);
		return at < 0 ? { key: l, size: NaN } : { key: l.slice(0, at), size: Number(l.slice(at).trim()) };
	})
	: [];

/** Each entry's current item. An entry whose function key no longer matches
 *  exactly (its `@line` moved, or a second function of that name appeared)
 *  is matched to the nearest unclaimed function of that name in that file. */
function matchEntries() {
	const byKey = new Map(items.map((it) => [it.key, it]));
	const claimed = new Set();
	const matched = new Map();
	for (const e of entries) if (byKey.has(e.key)) { matched.set(e, byKey.get(e.key)); claimed.add(e.key); }
	for (const e of entries) {
		if (matched.has(e)) continue;
		const [, base, line] = /^(.*?)(?:@(\d+))?$/.exec(e.key);
		if (!base.includes("#")) continue;
		const candidates = items.filter((it) => !claimed.has(it.key) && it.kind === "function" && it.key.replace(/@\d+$/, "") === base);
		const distance = (it) => (line ? Math.abs(it.line - Number(line)) : -it.size);
		const best = candidates.sort((a, b) => distance(a) - distance(b))[0];
		if (best) { matched.set(e, best); claimed.add(best.key); }
	}
	return matched;
}
let matched = matchEntries();

if (args.includes("--tighten")) {
	const kept = [];
	for (const e of entries) {
		const it = matched.get(e);
		if (it && bandOf(it, LIMITS) === "over") kept.push({ key: it.key, size: Math.min(e.size, it.size) });
	}
	writeRatchet(kept);
	console.log(`tightened ${rel(RATCHET)}: ${entries.length} → ${kept.length} items`);
	entries.splice(0, entries.length, ...kept);
	matched = matchEntries();
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const sizeText = (it) => `${it.key}: ${it.size} ${unitOf(it)} (cap ${capOf(it, LIMITS)})`;
const grew = [];
const shrank = [];
const stale = [];
for (const e of entries) {
	const it = matched.get(e);
	if (!it || bandOf(it, LIMITS) !== "over") stale.push(e.key);
	else if (!(it.size <= e.size)) grew.push(`${sizeText(it)}, recorded at ${e.size} in the ratchet`);
	else if (it.size < e.size) shrank.push(`${it.key}: ${it.size}, recorded at ${e.size}`);
}
const listed = new Set([...matched.values()].map((it) => it.key));
const fresh = over.filter((it) => !listed.has(it.key)).map(sizeText);

if (near.length) {
	console.log(NEARING_HEADING);
	const largest = near.sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
	for (const it of largest.slice(0, NEAR_LISTED)) console.log(`  ${sizeText(it)}`);
	if (largest.length > NEAR_LISTED) console.log(`  ... and ${largest.length - NEAR_LISTED} more (the codebase map lists them)`);
	console.log(`  When one of these grows, ${STEERING.charAt(0).toLowerCase()}${STEERING.slice(1)}`);
}
if (approximate) {
	console.log(`${approximate} JS/TS files were measured without the TypeScript compiler (\`typescript\` is not installed): ` +
		"line counts are approximate and function sizes were not measured.");
}

const problems = [];
if (fresh.length) problems.push(["Over the size cap:", fresh, STEERING]);
if (grew.length) problems.push(["Grew past its size in the ratchet (the ratchet only goes down):", grew, STEERING]);
if (shrank.length) problems.push(["Smaller than its recorded size (good); lower the ratchet to lock it in:", shrank, `Run: ${SELF} --tighten`]);
if (stale.length) {
	problems.push([`Back under the cap or gone, but still listed in ${rel(RATCHET)}:`, stale, `Remove those lines, or run: ${SELF} --tighten`]);
}
if (problems.length) {
	console.error("Code-size check failed (code lines only: comments and blank lines are free).");
	for (const [title, list, fix] of problems) {
		console.error(`\n${title}`);
		for (const p of list) console.error(`  ${p}`);
		console.error(`  ${fix}`);
	}
	process.exit(1);
}
const fnCount = items.length - files.length;
console.log(`Code-size check passed (${files.length} files, ${fnCount} functions; caps: file ${LIMITS.maxCode}, function ${LIMITS.maxFn} code lines; ` +
	`${entries.length} in the ratchet, ${near.length} nearing).`);
