#!/usr/bin/env node
/**
 * The structure checks as one command: the codebase map, the file-size
 * ceiling, module owners, doc paths. Every check runs even after one fails, so
 * a single run shows everything to fix. For a build or a harness gate that has
 * one slot for "is the structure right"; the individual scripts stay for
 * targeted runs.
 *
 * Usage:
 *   node check-structure.mjs [--root src]... [--max-loc 450] [--check]
 *
 * Without --check the map is REGENERATED (the build keeps it current, and the
 * commit carries it); with --check a stale map fails instead, which is what CI
 * wants. The map runs first so the doc-path check reads the map of this tree,
 * not the last one. Without --root the source roots come from the project kind
 * (project-languages.mjs: Cargo.toml → src; go.mod → internal/, cmd/, pkg/;
 * package.json → src or the framework's layout; otherwise src), and every
 * check is handed the same roots.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultRoots } from "./project-languages.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? [name, args[i + 1]] : [];
};
const given = args.flatMap((a, i) => (a === "--root" ? [args[i + 1]] : []));
const roots = (given.length ? given : defaultRoots(process.cwd())).flatMap((r) => ["--root", r]);
const maxLoc = opt("--max-loc");
const check = args.includes("--check");
const here = fileURLToPath(new URL(".", import.meta.url));

const steps = [
	["codebase-map.mjs", [...roots, ...maxLoc, ...(check ? ["--check"] : [])]],
	["check-file-size.mjs", [...roots, ...maxLoc]],
	["check-module-owners.mjs", [...roots]],
	["check-doc-paths.mjs", []],
];

let failed = 0;
for (const [script, flags] of steps) {
	const r = spawnSync(process.execPath, [here + script, ...flags], { stdio: "inherit" });
	if (r.status !== 0) failed += 1;
}
if (failed) {
	console.error(`\ncheck-structure: ${failed} of ${steps.length} checks failed`);
	process.exit(1);
}
console.log("check-structure: OK");
