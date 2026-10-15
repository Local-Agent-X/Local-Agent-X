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
 *
 * The module-level questions ("which modules import this one", dead modules)
 * are docs/codebase-map.md and `npm run deps`.
 */
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { getLanguageIntel, type ReferenceHit, type SymbolLocation } from "../src/language-intel/index.js";

const REPO = process.cwd();
const SRC = resolve(REPO, "src");
const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith("--"));
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
  // An import/re-export line, including one name alone on a line inside a
  // multi-line `import { … }` / `export { … } from` block.
  const importLine = /^\s*(import\b|export\s*(\*|\{|type\s*\{)|\}\s*from\s|(type\s+)?[A-Za-z_$][\w$]*(\s+as\s+[A-Za-z_$][\w$]*)?,?\s*$)/;
  const uses = hits.filter((h) => !h.isDefinition && !importLine.test(h.lineText));
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

async function main(): Promise<number> {
  if (args.includes("--duplicates")) {
    await duplicates();
    return 0;
  }
  if (!query) {
    console.error("usage: npm run refs -- <Name> | <file>#<Name> | <file>:<line>[:col] | --duplicates  [--tests]");
    return 2;
  }
  const started = Date.now();
  const targets = await targetsOf(query);
  if (targets.length === 0) {
    console.error(`No module-level declaration named ${query} under src/. For a member or a local, pass <file>:<line> of its declaration.`);
    return 1;
  }
  for (const t of targets) print(t, await intel.findReferences(t));
  console.error(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return 0;
}

main().then((code) => {
  intel.dispose();
  process.exit(code);
});
