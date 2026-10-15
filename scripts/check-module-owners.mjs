#!/usr/bin/env node
/**
 * Every module has an owner on record.
 *
 * A top-level directory under the source root must either carry its own
 * AGENTS.md or be named in ARCHITECTURE.md (as `<root>/<dir>/`). A module
 * nobody wrote down is where an agent builds a second one: it can't extend an
 * owner it can't find, and the next reader can't tell live code from a
 * leftover. The build fails until the module has a row saying what it owns and
 * what it does not. A new module therefore always arrives with that decision
 * made, which is the point.
 *
 * check-doc-paths covers the other direction (a doc naming a module that no
 * longer exists).
 *
 * Usage:
 *   node check-module-owners.mjs [--root src] [--arch ARCHITECTURE.md]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};

const REPO = process.cwd();
const ROOT = resolve(REPO, opt("--root", "src"));
const ARCH = resolve(REPO, opt("--arch", "ARCHITECTURE.md"));

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv", "coverage", ".next", "vendor", "third_party"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const TEST = /\.(test|spec)\.[^.]+$|^test_.*\.py$|_test\.py$/;

/** Whether `dir` holds at least one non-test source file, at any depth. */
function holdsSource(dir) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name) || name === "__tests__" || name === "tests" || name === "test") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory() ? holdsSource(p) : SOURCE.test(name) && !name.endsWith(".d.ts") && !TEST.test(name)) return true;
	}
	return false;
}

if (!existsSync(ROOT)) {
	console.error(`source root not found: ${ROOT} (pass --root)`);
	process.exit(2);
}
const arch = existsSync(ARCH) ? readFileSync(ARCH, "utf8") : "";
const rootRel = relative(REPO, ROOT).split(sep).join("/");

const modules = readdirSync(ROOT)
	.filter((d) => !SKIP_DIRS.has(d) && !d.startsWith(".") && !d.startsWith("__"))
	.filter((d) => statSync(join(ROOT, d)).isDirectory() && holdsSource(join(ROOT, d)))
	.sort();

const named = (d) => arch.includes(`${rootRel}/${d}/`) || arch.includes(`\`${rootRel}/${d}\``);
const unowned = modules.filter((d) => !existsSync(join(ROOT, d, "AGENTS.md")) && !named(d));

if (unowned.length > 0) {
	console.error(`check-module-owners: ${unowned.length} module(s) with no owner on record:`);
	for (const d of unowned) console.error(`  ${rootRel}/${d}/`);
	console.error(
		`\nGive each one a row in ${relative(REPO, ARCH)} (what it owns, what it does not, its entry file) ` +
			"or its own AGENTS.md. If it duplicates an existing module, fold it in instead; if nothing uses it, delete it.",
	);
	process.exit(1);
}
console.log(`check-module-owners: OK (${modules.length} modules, each with an owner on record)`);
