#!/usr/bin/env node
/**
 * Fail when an agent-facing doc points at a path that does not exist.
 *
 * A guidance doc that names a missing file sends every agent that trusts it
 * down a dead end. This checks markdown links and backticked paths (any span
 * containing a "/") in the live docs. Historical records — docs/history/ and
 * docs/adr/ — are skipped on purpose: they describe the past.
 *
 * Skipped spans: URLs, absolute or home paths (/api/x, ~/.cfg), globs,
 * placeholders (<name>, {x}), and anything under a gitignored directory
 * (per-machine paths). Put `doc-paths:ignore` on a line to exempt an
 * intentional example of a path that should not exist.
 *
 * Usage: node check-doc-paths.mjs [--verbose] [doc.md ...]
 *   --verbose also lists gitignored paths the docs name (per-machine, not failures).
 * Default docs: AGENTS.md, CLAUDE.md, ARCHITECTURE.md, README.md, every nested
 * AGENTS.md / CLAUDE.md / README.md, and docs/**.md except history and ADRs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO = process.cwd();
// vendor/ and third_party/ docs are someone else's — their paths point into their own repos.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv", "coverage", "vendor", "third_party"]);
const GUIDE_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md", "README.md"]);

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

const rel = (p) => relative(REPO, p).split(sep).join("/");
function defaultDocs() {
	return walk(REPO).filter((p) => {
		const r = rel(p);
		if (!r.endsWith(".md")) return false;
		if (r.startsWith("docs/history/") || r.startsWith("docs/adr/")) return false;
		return r.startsWith("docs/") || GUIDE_NAMES.has(r.split("/").pop());
	});
}

function gitIgnored(paths) {
	if (!paths.length) return new Set();
	try {
		const out = execFileSync("git", ["check-ignore", "-v", "--no-index", "--stdin"], { cwd: REPO, input: paths.join("\n"), encoding: "utf8" });
		return parseIgnored(out);
	} catch (err) {
		return parseIgnored(String(err.stdout ?? ""));
	}
}

// `-v` lines are `source:line:pattern<TAB>path`. git sometimes reports a hit
// with an EMPTY pattern for a missing directory; that is not a real ignore
// rule, so only a non-empty pattern counts.
function parseIgnored(out) {
	const ignored = new Set();
	for (const line of out.split("\n")) {
		const m = line.match(/^[^:]+:\d+:(.*)\t(.+)$/);
		if (m && m[1].trim()) ignored.add(m[2].trim());
	}
	return ignored;
}

const LINK = /\]\(([^)\s]+)\)/g;
const TICK = /`([^`\n]+)`/g;
const TOP_LEVEL = new Set(readdirSync(REPO));

// A backticked span is treated as a repo path only when it looks like one:
// anchored at a real top-level entry, explicitly relative, or ending in a file
// extension. That keeps `pending/running`, `next/dynamic` and host names out.
function looksLikePath(s) {
	const first = s.split("/")[0];
	if (first.includes(".") && !first.startsWith(".")) return false; // host name or versioned id
	return TOP_LEVEL.has(first) || s.startsWith("./") || s.startsWith("../") || /\.[a-z][a-z0-9]{0,4}$/i.test(s);
}

function candidates(line) {
	const out = [];
	for (const m of line.matchAll(LINK)) out.push(m[1]);
	for (const m of line.matchAll(TICK)) if (m[1].includes("/")) out.push(m[1]);
	return out
		.map((s) => s.replace(/#.*$/, "").replace(/:\d+(-\d+)?$/, "").trim())
		.filter((s) => s && /^[\w.@-][\w./@-]*$/.test(s) && !/^(https?|mailto):/.test(s) && !s.startsWith("@") && looksLikePath(s));
}

// Docs often write a path relative to the subsystem under discussion
// (`turn-loop/compact-history.ts` inside a canonical-loop paragraph). Accept a
// span when some real repo path ends with it; a fully stale path matches nothing.
const allPaths = walk(REPO, []).flatMap((p) => {
	const r = rel(p);
	const parts = r.split("/");
	return [r, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))];
});
const suffixIndex = new Set(allPaths.map((p) => "/" + p));
const existsBySuffix = (spec) => {
	const s = "/" + spec.replace(/^(\.\.?\/)+/, "").replace(/\/$/, "");
	// TS ESM sources import `./x.js` for `./x.ts`; docs copy that spelling.
	const variants = /\.js$/.test(s) ? [s, s.replace(/\.js$/, ".ts"), s.replace(/\.js$/, ".tsx")] : [s];
	for (const p of suffixIndex) if (variants.some((v) => p === v || p.endsWith(v))) return true;
	return false;
};

const docs = process.argv.slice(2).length ? process.argv.slice(2).map((p) => resolve(REPO, p)) : defaultDocs();
const misses = [];
for (const doc of docs) {
	const lines = readFileSync(doc, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (line.includes("doc-paths:ignore")) return;
		for (const spec of candidates(line)) {
			const fromRoot = resolve(REPO, spec);
			const fromDoc = resolve(dirname(doc), spec);
			if (existsSync(fromRoot) || existsSync(fromDoc) || existsBySuffix(spec)) continue;
			// Keep a trailing slash so git matches directory-only ignore rules like `dist/`.
			const path = rel(fromRoot) + (spec.endsWith("/") ? "/" : "");
			misses.push({ where: `${rel(doc)}:${i + 1}`, spec, path });
		}
	});
}
// git rejects the whole batch if any path is outside the repo, so only ask about inside ones.
const ignored = gitIgnored(misses.map((m) => m.path).filter((p) => !p.startsWith("../")));
const real = misses.filter((m) => !ignored.has(m.path));
// Gitignored paths are usually per-machine (workspace/, build output), so they
// don't fail the check — but a deleted module can be gitignored too, so list them.
const perMachine = misses.filter((m) => ignored.has(m.path));
if (perMachine.length && process.argv.includes("--verbose")) {
	console.warn(`Not on this machine, gitignored — confirm each is per-machine, not deleted:\n  ${perMachine.map((m) => `${m.where} → ${m.spec}`).join("\n  ")}`);
}
if (real.length) {
	console.error(`Docs point at ${real.length} missing path(s):\n  ${real.map((m) => `${m.where} → ${m.spec}`).join("\n  ")}`);
	console.error("Fix the path, delete the stale claim, or mark an intentional example with doc-paths:ignore.");
	process.exit(1);
}
console.log(`Doc paths OK (${docs.length} docs checked).`);
