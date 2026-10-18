#!/usr/bin/env node
/**
 * Every module has an owner on record.
 *
 * A module under a source root (what counts as one is per language —
 * project-languages.mjs: a top-level directory for JS/TS and Python, a
 * top-level directory or .rs file for Rust, a package directory for Go) must
 * either carry its own AGENTS.md or be named in ARCHITECTURE.md by its path
 * (`src/auth/`, `src/auth.rs`, `internal/auth/`). A module nobody wrote down
 * is where an agent builds a second one: it can't extend an owner it can't
 * find, and the next reader can't tell live code from a leftover. The build
 * fails until the module has a row saying what it owns and what it does not.
 * A new module therefore always arrives with that decision made, which is the
 * point.
 *
 * check-doc-paths covers the other direction (a doc naming a module that no
 * longer exists).
 *
 * Usage:
 *   node check-module-owners.mjs [--root src]... [--arch ARCHITECTURE.md]
 *
 * --root may repeat; without it the roots come from the project kind (see
 * project-languages.mjs).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { defaultRoots, isTestPath, moduleOf, walkSource } from "./project-languages.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const optAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const REPO = process.cwd();
const ROOTS = (optAll("--root").length ? optAll("--root") : defaultRoots(REPO)).map((r) => resolve(REPO, r));
const ARCH = resolve(REPO, opt("--arch", "ARCHITECTURE.md"));

const arch = existsSync(ARCH) ? readFileSync(ARCH, "utf8") : "";
const posix = (p) => relative(REPO, p).split(sep).join("/");

// A project before its first source file has no modules to own yet. Test
// files never make a module on their own: a tests/ folder is not a capability.
const modules = new Map();
for (const root of ROOTS) {
	if (!existsSync(root)) continue;
	for (const f of walkSource(root)) {
		if (isTestPath(posix(f))) continue;
		const m = moduleOf(f, root, REPO);
		if (m && (!modules.has(m.key) || m.display.endsWith("/"))) modules.set(m.key, m);
	}
}

const named = (m) => arch.includes(m.display) || arch.includes(`\`${m.key}\``) || arch.includes(`${m.key}/`);
const hasGuide = (m) => m.dir !== null && existsSync(join(m.dir, "AGENTS.md"));
const unowned = [...modules.values()].filter((m) => !hasGuide(m) && !named(m)).sort((a, b) => a.key.localeCompare(b.key));

if (unowned.length > 0) {
	console.error(`check-module-owners: ${unowned.length} module(s) with no owner on record:`);
	for (const m of unowned) console.error(`  ${m.display}`);
	console.error(
		`\nGive each one a row in ${relative(REPO, ARCH)} (what it owns, what it does not, its entry file) ` +
			"or its own AGENTS.md. If it duplicates an existing module, fold it in instead; if nothing uses it, delete it.",
	);
	process.exit(1);
}
console.log(`check-module-owners: OK (${modules.size} modules, each with an owner on record)`);
