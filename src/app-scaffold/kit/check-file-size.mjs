#!/usr/bin/env node
/**
 * File-size ceiling for source files, with a shrink-only allowlist.
 *
 * Small single-purpose files are cheaper for an agent to read whole and easier
 * to review; past the ceiling a file is almost always doing two jobs. New
 * projects start with an empty allowlist. A retrofitted repo lists today's
 * oversized files in the allowlist once; after that the list can only shrink —
 * a listed file that drops under the ceiling must be removed from the list, so
 * the exemption never outlives the problem.
 *
 * Usage:
 *   node check-file-size.mjs [--root src] [--max-loc 450] [--allow .file-size-allow]
 *   node check-file-size.mjs --write-allowlist     seed the allowlist (retrofit only)
 *
 * Allowlist format: one repo-relative path per line; `#` starts a comment.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};

const REPO = process.cwd();
const ROOTS = args.flatMap((a, i) => (a === "--root" ? [args[i + 1]] : []));
const MAX_LOC = Number(opt("--max-loc", "450"));
const ALLOW = resolve(REPO, opt("--allow", ".file-size-allow"));

// vendor/ and third_party/ hold code we ship but don't own.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv", "coverage", ".next", "vendor", "third_party"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|php)$/;
const TEST = /(\.(test|spec)\.[^.]+$)|(^test_.*\.py$)|(_test\.(py|go)$)/;

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (SOURCE.test(name) && !name.endsWith(".d.ts") && !TEST.test(name)) out.push(p);
	}
	return out;
}

const rel = (p) => relative(REPO, p).split(sep).join("/");
const files = (ROOTS.length ? ROOTS : ["src"]).flatMap((r) => (existsSync(resolve(REPO, r)) ? walk(resolve(REPO, r)) : []));
const oversized = new Map();
for (const f of files) {
	const text = readFileSync(f, "utf8");
	const loc = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	if (loc > MAX_LOC) oversized.set(rel(f), loc);
}

if (args.includes("--write-allowlist")) {
	const body = [
		`# Files over ${MAX_LOC} lines, grandfathered when the ceiling was adopted.`,
		"# Shrink-only: split a file, then delete its line. Never add new entries.",
		...[...oversized.keys()].sort(),
		"",
	].join("\n");
	writeFileSync(ALLOW, body);
	console.log(`wrote ${rel(ALLOW)} with ${oversized.size} grandfathered files`);
	process.exit(0);
}

const allowed = new Set(
	existsSync(ALLOW)
		? readFileSync(ALLOW, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
		: [],
);
const errors = [];
for (const [p, loc] of oversized) {
	if (!allowed.has(p)) errors.push(`${p}: ${loc} lines (limit ${MAX_LOC}) — split it by responsibility`);
}
for (const p of allowed) {
	if (!oversized.has(p)) errors.push(`${p}: listed in ${rel(ALLOW)} but no longer oversized (or gone) — delete the line`);
}
if (errors.length) {
	console.error(`File-size check failed:\n  ${errors.join("\n  ")}`);
	process.exit(1);
}
console.log(`File-size check passed (${files.length} files, limit ${MAX_LOC}, ${allowed.size} grandfathered).`);
