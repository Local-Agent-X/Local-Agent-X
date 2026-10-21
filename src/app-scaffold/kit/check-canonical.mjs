#!/usr/bin/env node
/**
 * No new canonical drift: a name may not be declared in a second source root.
 *
 * What counts as drift, and how declarations are read: canonical-drift.mjs.
 * In short, a *shadow* re-declares something the canonical root (--canonical,
 * the shared package) exports, and a *duplicate* is a name exported from two
 * other roots. Either way one job now has two implementations that will drift.
 * With a single source root there is nothing to compare and the check passes.
 *
 * The ratchet (--ratchet, default .canonical-drift) lists the drift that
 * existed when the check was adopted, one finding per line:
 *     parseHeightToInches apps/mobile,apps/web/src,supabase/functions
 *     supabase apps/mobile,apps/web/src   # each app builds its own client
 * A trailing `# note` says why a pair is intentional; a line without one is
 * debt. The check fails when a finding is not listed, when a listed name
 * spreads to another root, when it shrank and the line was not lowered, and
 * when it is gone and still listed. A line is added only for a copy that must
 * exist (and then with its reason), never to get a new copy past the check.
 *
 * Usage:
 *   node check-canonical.mjs [--root src]... [--canonical packages/shared/src]...
 *                            [--exclude <regex>]... [--ratchet .canonical-drift]
 *   ... --write-ratchet   (re)write the ratchet with every finding now (retrofit; sorted, deterministic)
 *   ... --tighten         drop roots and lines that are gone, keeping notes
 *   ... --self "<cmd>"    how this check is run, for the commands it prints
 * --exclude defaults to `\.generated\.` (generated types repeat by design).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots } from "./project-languages.mjs";
import { driftFindings, scanDeclarations } from "./canonical-drift.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const optAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const REPO = process.cwd();
const rel = (p) => relative(REPO, p).split(sep).join("/");
const ROOTS = (optAll("--root").length ? optAll("--root") : defaultRoots(REPO)).map((r) => resolve(REPO, r)).filter(existsSync);
const CANONICAL = optAll("--canonical").map((r) => rel(resolve(REPO, r)));
const EXCLUDE = (optAll("--exclude").length ? optAll("--exclude") : ["\\.generated\\."]).map((s) => new RegExp(s));
const RATCHET = resolve(REPO, opt("--ratchet", ".canonical-drift"));
const SELF = opt("--self", null)
	?? `node ${rel(fileURLToPath(import.meta.url))} ${args.filter((a, i) => !["--write-ratchet", "--tighten"].includes(a) && args[i - 1] !== "--self").join(" ")}`.trim();

for (const c of CANONICAL) {
	if (!ROOTS.some((r) => rel(r) === c)) {
		console.error(`check-canonical: --canonical ${c} is not one of the source roots (${ROOTS.map(rel).join(", ")}).`);
		process.exit(2);
	}
}
if (ROOTS.length < 2) {
	console.log("check-canonical: OK (one source root, nothing to compare)");
	process.exit(0);
}

const findings = driftFindings(scanDeclarations(REPO, ROOTS, { exclude: EXCLUDE }), CANONICAL);
const byName = new Map(findings.map((f) => [f.name, f]));

// ── Ratchet ──────────────────────────────────────────────────────────────────
const HEADER = [
	"# Canonical-drift ratchet: names declared in more than one source root when the check was adopted.",
	"# `name root,root  # why both must exist` for an intentional pair; no note means debt to fold into one owner.",
	"# Lines only go away (--tighten). Add one only for a copy that must exist, with its reason.",
];
const parse = (line) => {
	const [body, ...note] = line.split("#");
	const [name, roots = ""] = body.trim().split(/\s+/);
	return { name, roots: roots.split(",").filter(Boolean).sort(), note: note.join("#").trim() };
};
const entries = existsSync(RATCHET)
	? readFileSync(RATCHET, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).map(parse)
	: [];
const write = (list) => {
	const lines = list.sort((a, b) => a.name.localeCompare(b.name))
		.map((e) => `${e.name} ${e.roots.join(",")}${e.note ? `  # ${e.note}` : ""}`);
	writeFileSync(RATCHET, [...HEADER, ...lines, ""].join("\n"));
};

if (args.includes("--write-ratchet")) {
	const notes = new Map(entries.map((e) => [e.name, e.note]));
	write(findings.map((f) => ({ name: f.name, roots: f.roots, note: notes.get(f.name) ?? "" })));
	console.log(`wrote ${rel(RATCHET)}: ${findings.length} names declared in more than one root`);
	process.exit(0);
}
if (args.includes("--tighten")) {
	const kept = entries.flatMap((e) => {
		const f = byName.get(e.name);
		const roots = f ? e.roots.filter((r) => f.roots.includes(r)) : [];
		return roots.length > 1 ? [{ ...e, roots }] : [];
	});
	console.log(`tightened ${rel(RATCHET)}: ${entries.length} → ${kept.length} names`);
	write(kept);
	entries.splice(0, entries.length, ...kept);
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const listed = new Map(entries.map((e) => [e.name, e]));
const where = (f) => `${f.name}: ${f.files.join(", ")}`;
const fresh = [];
const spread = [];
const shrank = [];
const stale = [];
for (const f of findings) {
	const e = listed.get(f.name);
	if (!e) fresh.push(f);
	else if (f.roots.some((r) => !e.roots.includes(r))) spread.push(f);
	else if (f.roots.length < e.roots.length) shrank.push(`${f.name}: now in ${f.roots.join(", ")}`);
}
for (const e of entries) if (!byName.has(e.name)) stale.push(e.name);

const STEER_SHADOW = "Import it from the canonical root instead of declaring it again. If it differs on purpose, rename it after what makes it different.";
const STEER_DUP = "Pick one owner, usually by moving it into the canonical root, and import it from there. /canonical-check finds the owner before you build.";
const problems = [];
const shadows = [...fresh, ...spread].filter((f) => f.kind === "shadow");
const dups = [...fresh, ...spread].filter((f) => f.kind === "duplicate");
if (shadows.length) problems.push(["Re-declares a name the canonical root exports:", shadows.map(where), STEER_SHADOW]);
if (dups.length) problems.push(["Exported from more than one source root:", dups.map(where), STEER_DUP]);
if (shrank.length) problems.push(["Fewer copies than recorded (good); lock it in:", shrank, `Run: ${SELF} --tighten`]);
if (stale.length) problems.push([`Folded into one owner, but still listed in ${rel(RATCHET)}:`, stale, `Remove those lines, or run: ${SELF} --tighten`]);

if (problems.length) {
	console.error("check-canonical failed: one job, more than one implementation.");
	for (const [title, list, fix] of problems) {
		console.error(`\n${title}`);
		for (const p of list) console.error(`  ${p}`);
		console.error(`  ${fix}`);
	}
	process.exit(1);
}
const debt = entries.filter((e) => !e.note).length;
console.log(`check-canonical: OK (${ROOTS.length} roots${CANONICAL.length ? `, canonical ${CANONICAL.join(", ")}` : ""}; ` +
	`${entries.length} in the ratchet, ${debt} of them debt)`);
