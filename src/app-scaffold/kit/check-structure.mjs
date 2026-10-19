#!/usr/bin/env node
/**
 * The structure checks as one command: the codebase map, module owners, doc
 * paths, the code-size caps. Every check runs even after one fails, so a
 * single run shows everything to fix. For a build or a harness gate that has
 * one slot for "is the structure right"; the individual scripts stay for
 * targeted runs.
 *
 * Usage:
 *   node check-structure.mjs [--root src]... [--check]
 *        [--max-code 400] [--warn-code 320] [--max-fn 100] [--warn-fn 60] [--ratchet .code-size-ratchet]
 *        [--typescript <dir of a typescript package with the compiler API>]
 *
 * Without --check the map is REGENERATED (the build keeps it current, and the
 * commit carries it); with --check a stale map fails instead, which is what CI
 * wants. The map runs first so the doc-path check reads the map of this tree,
 * not the last one. Without --root the source roots come from the project kind
 * (project-languages.mjs: Cargo.toml → src; go.mod → internal/, cmd/, pkg/;
 * package.json → src or the framework's layout; otherwise src), and every
 * check is handed the same roots, and the map and the size check the same caps.
 *
 * A passing check's output is printed as it finishes; a failing check's output
 * is held and printed last, just above the summary, so a reader that keeps only
 * the tail of the output (a harness gate) still sees what to fix.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultRoots } from "./project-languages.mjs";
import { limitArgs, limitsFromArgs } from "./code-size.mjs";
import { applyTypeScriptFlag } from "./typescript-api.mjs";

const args = process.argv.slice(2);
// The checks below are spawned and inherit it (typescript-api.mjs).
applyTypeScriptFlag(args);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? [name, args[i + 1]] : [];
};
const given = args.flatMap((a, i) => (a === "--root" ? [args[i + 1]] : []));
const roots = (given.length ? given : defaultRoots(process.cwd())).flatMap((r) => ["--root", r]);
const limits = limitArgs(limitsFromArgs(args));
const check = args.includes("--check");
const here = fileURLToPath(new URL(".", import.meta.url));

const steps = [
	["codebase-map.mjs", [...roots, ...limits, ...(check ? ["--check"] : [])]],
	["check-module-owners.mjs", [...roots]],
	["check-doc-paths.mjs", []],
	["check-code-size.mjs", [...roots, ...limits, ...opt("--ratchet")]],
];

const failed = [];
for (const [script, flags] of steps) {
	const r = spawnSync(process.execPath, [here + script, ...flags], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `${r.error.message}\n` : ""}`;
	if (r.status === 0) process.stdout.write(out);
	else failed.push(out);
}
if (failed.length) {
	for (const out of failed) process.stderr.write(`\n${out}`);
	console.error(`\ncheck-structure: ${failed.length} of ${steps.length} checks failed`);
	process.exit(1);
}
console.log("check-structure: OK");
