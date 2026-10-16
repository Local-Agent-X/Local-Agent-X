/**
 * `npm run refs` — who uses a function, class, type or variable, answered by
 * the same language service the product's agents use (src/language-intel/,
 * behind `structural_search`), so a renamed import or a barrel re-export
 * counts where a text search misses it. On demand only: it reads the tree as
 * it is right now, so it is never stale.
 *
 *   npm run refs -- <Name>               every module-level declaration named <Name>, with its uses
 *   npm run refs -- <file>#<Name>        only the declaration in <file>
 *   npm run refs -- <file>:<line>[:col]  the symbol at a position (members, locals)
 *   npm run refs -- --duplicates         exported names declared in more than one non-test file
 *   --tests                              list each use in test files (default: counted only)
 *   --depth N                            how far a change reaches: the declarations that use it,
 *                                        those that use them, ... N hops out, and the tests to run
 *                                        (scripts/lib/symbol-reach.ts)
 *
 * The module-level questions ("which modules import this one", dead modules)
 * are docs/codebase-map.md and `npm run deps`.
 */
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { getLanguageIntel, type ReferenceHit, type SymbolLocation } from "../src/language-intel/index.js";
import { IMPORT_LINE, symbolReach } from "./lib/symbol-reach.js";

const REPO = process.cwd();
const SRC = resolve(REPO, "src");
const args = process.argv.slice(2);
const depthAt = args.indexOf("--depth");
const depth = depthAt >= 0 ? Number(args[depthAt + 1]) : 0;
const query = args.find((a, i) => !a.startsWith("--") && (depthAt < 0 || i !== depthAt + 1));
const listTests = args.includes("--tests");
const rel = (f: string): string => relative(REPO, f).split(sep).join("/");
const isTest = (f: string): boolean => /\.test\.[^.]+$|\.test-helper\.[^.]+$/.test(f) || /(^|\/)(__tests__|test)\//.test(rel(f));
const intel = getLanguageIntel();

async function duplicates(): Promise<void> {
  const byName = new Map<string, string[]>();
  for (const d of await intel.listExportedDeclarations(SRC)) {
    if (isTest(d.file)) continue;
    byName.set(d.name, [...(byName.get(d.name) ?? []), `${rel(d.file)}:${d.line} (${d.kind})`]);
  }
  const dups = [...byName].filter(([, at]) => at.length > 1).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  console.log(`# Exported names declared in more than one non-test file (${dups.length})`);
  console.log("The same name is not always the same job; each is a place to check for a second implementation.\n");
  for (const [name, at] of dups) console.log(`${name} (${at.length})\n${at.sort().map((a) => `  ${a}`).join("\n")}`);
}

/** The declarations a query names: a position, one file's declaration, or every module-level one. */
async function targetsOf(q: string): Promise<SymbolLocation[]> {
  const pos = /^(.+?):(\d+)(?::(\d+))?$/.exec(q);
  if (pos && !q.includes("#")) {
    const file = resolve(REPO, pos[1]);
    const line = Number(pos[2]);
    const text = readFileSync(file, "utf8").split(/\r?\n/)[line - 1] ?? "";
    const column = pos[3] ? Number(pos[3]) : (text.search(/[A-Za-z_$]/) + 1 || 1);
    return [{ file, line, column }];
  }
  const [file, name] = q.includes("#") ? q.split("#") : [null, q];
  const found = await intel.findSymbolPositions(SRC, name, { limit: 200 });
  return found.filter((p) => p.kind === "declaration" && p.topLevel && (!file || resolve(p.file) === resolve(REPO, file)));
}

function print(target: SymbolLocation, hits: ReferenceHit[]): void {
  const def = hits.find((h) => h.isDefinition && h.file === target.file && h.line === target.line);
  const uses = hits.filter((h) => !h.isDefinition && !IMPORT_LINE.test(h.lineText));
  const importLines = hits.filter((h) => !h.isDefinition).length - uses.length;
  const group = (list: ReferenceHit[]) => {
    const m = new Map<string, ReferenceHit[]>();
    for (const h of list) m.set(h.file, [...(m.get(h.file) ?? []), h]);
    return [...m].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  };
  const prod = group(uses.filter((h) => !isTest(h.file)));
  const tests = group(uses.filter((h) => isTest(h.file)));
  const n = (g: [string, ReferenceHit[]][]) => g.reduce((s, [, l]) => s + l.length, 0);
  console.log(`\n## ${rel(target.file)}:${target.line}  ${(def?.lineText ?? "").trim().slice(0, 120)}`);
  console.log(`${n(prod)} uses in ${prod.length} files · ${n(tests)} in ${tests.length} test files · ${importLines} import/re-export lines`);
  for (const [f, list] of prod) {
    console.log(`\n${rel(f)}`);
    for (const h of list) console.log(`  ${String(h.line).padStart(5)}  ${h.lineText.trim().slice(0, 160)}`);
  }
  if (tests.length) {
    console.log("\ntests:");
    for (const [f, list] of tests) {
      console.log(`  ${rel(f)} (${list.length})`);
      if (listTests) for (const h of list) console.log(`    ${String(h.line).padStart(5)}  ${h.lineText.trim().slice(0, 160)}`);
    }
  }
}

async function printReach(target: SymbolLocation): Promise<void> {
  // Only a runnable test ends the walk; a test helper is followed to the tests that use it.
  const reach = await symbolReach((loc) => intel.findReferences(loc), target, depth, (f) => /\.test\.[^.]+$/.test(f));
  const line = readFileSync(target.file, "utf8").split(/\r?\n/)[target.line - 1] ?? "";
  console.log(`\n## Reach of ${rel(target.file)}:${target.line}  ${line.trim().slice(0, 100)}  (depth ${depth})`);
  reach.hops.forEach((decls, i) => {
    const byFile = new Map<string, string[]>();
    for (const d of decls) byFile.set(d.file, [...(byFile.get(d.file) ?? []), `${d.name}:${d.line}`]);
    console.log(`\nhop ${i + 1}: ${decls.length} declarations in ${byFile.size} files`);
    for (const [f, names] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${rel(f)}  ${names.join(", ")}`);
  });
  if (reach.moduleScope.length) {
    console.log("\nused at module scope (the file is reached; nothing further to follow):");
    for (const m of reach.moduleScope) console.log(`  ${rel(m.file)}:${m.line}`);
  }
  if (reach.capped) console.log("\n(stopped early: over 300 declarations reached; narrow the target or lower --depth)");
  console.log(`\ntests to run (${reach.tests.length}): the test files that use a reached declaration`);
  for (const t of reach.tests) console.log(`  ${rel(t)}`);
  console.log("\nEvery test importing a reached file, symbol used or not: npm run deps -- <file> --depth N");
}

async function main(): Promise<number> {
  if (args.includes("--duplicates")) {
    await duplicates();
    return 0;
  }
  if (!query || !Number.isInteger(depth) || depth < 0) {
    console.error("usage: npm run refs -- <Name> | <file>#<Name> | <file>:<line>[:col] | --duplicates  [--tests] [--depth N]");
    return 2;
  }
  const started = Date.now();
  const targets = await targetsOf(query);
  if (targets.length === 0) {
    console.error(`No module-level declaration named ${query} under src/. For a member or a local, pass <file>:<line> of its declaration.`);
    return 1;
  }
  for (const t of targets) {
    if (depth > 0) await printReach(t);
    else print(t, await intel.findReferences(t));
  }
  console.error(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return 0;
}

main().then((code) => {
  intel.dispose();
  process.exit(code);
});
