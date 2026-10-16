#!/usr/bin/env node
/**
 * `npm run deps -- <file or dir> [--depth N]` — who a change to a file or
 * module reaches through imports, read off the compiler's import graph
 * (scripts/lib/import-graph.mjs, the same graph as docs/codebase-map.md).
 *
 *   hop 1      the files that import it directly (the default, --depth 1)
 *   hop 2..N   the files that import a file of the hop before
 *   tests      every test that imports it or a reached file, through any test
 *              helper: the tests to run
 *
 * The map's per-directory counts answer "how wired-in is this module"; this
 * answers "who exactly would a change here reach". For one function, class or
 * type rather than a whole file, `npm run refs -- <Name> --depth N`.
 */
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImportGraph, importersByHop, isTestSide, testsReaching } from "./lib/import-graph.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SRC_ROOT = resolve(REPO_ROOT, "src");
const args = process.argv.slice(2);
const depthAt = args.indexOf("--depth");
const depth = depthAt >= 0 ? Number(args[depthAt + 1]) : 1;
const path = args.find((a, i) => !a.startsWith("--") && (depthAt < 0 || i !== depthAt + 1));

if (!path || !Number.isInteger(depth) || depth < 1) {
  console.error("usage: npm run deps -- <file or dir> [--depth N]");
  process.exit(2);
}

const target = resolve(REPO_ROOT, path);
const inside = (p) => p === target || p.startsWith(target + sep);
const posixRel = (p) => relative(REPO_ROOT, p).split(sep).join("/");
const unit = (p) => { const parts = relative(SRC_ROOT, p).split(sep); return parts.length > 1 ? parts[0] : "(src root)"; };

function printGrouped(title, files) {
  const byUnit = new Map();
  for (const f of files) byUnit.set(unit(f), [...(byUnit.get(unit(f)) ?? []), posixRel(f)]);
  console.log(`\n## ${title} (${files.length} files across ${byUnit.size} modules)`);
  for (const [u, list] of [...byUnit].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    console.log(`\n${u}/ (${list.length})`);
    for (const p of list.sort()) console.log(`  ${p}`);
  }
}

const graph = buildImportGraph(REPO_ROOT);
if (!graph.files.some(inside)) {
  console.error(`No source file under src/ or test/ at ${posixRel(target)}.`);
  process.exit(1);
}
const hops = importersByHop(graph, target, depth);
const reached = [...graph.files.filter(inside), ...hops.flat().filter((f) => !isTestSide(f))];
const tests = testsReaching(graph, reached);

console.log(`# Dependencies of ${posixRel(target)} (non-test files; static and dynamic imports, resolved by the compiler)`);
hops.forEach((files, i) => {
  const prod = files.filter((f) => !isTestSide(f));
  printGrouped(i === 0 ? "Imported by" : `Reached at hop ${i + 1} (imports a hop-${i} file)`, prod);
});
if (depth === 1) {
  const usesFrom = new Set(graph.files.filter((f) => inside(f) && !isTestSide(f)).flatMap((f) => [...graph.importsOf.get(f)]).filter((t) => !inside(t)));
  printGrouped("Imports from", [...usesFrom]);
}
console.log(`\n## Tests to run: every test that imports it or a file listed above, helpers included (${tests.length})`);
for (const t of tests.map(posixRel).sort()) console.log(`  ${t}`);
console.log("\nFor one function, class or type rather than a whole file: npm run refs -- <Name> [--depth N]");
