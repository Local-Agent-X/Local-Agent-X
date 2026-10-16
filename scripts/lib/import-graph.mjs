/**
 * The file-level import graph of src/, read by the TypeScript compiler: its
 * own scanner finds every import, export-from, `import()` and `require()` (a
 * specifier inside a comment or a string is not one), and its own module
 * resolution, with the repo's tsconfig options, says which file each one
 * reaches (an ESM `./x.js` lands on `x.ts`). One graph feeds the codebase map's
 * importer counts and `npm run deps`, so the two never disagree.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ts from "typescript";

const isSource = (p) => /\.(ts|tsx)$/.test(p) && !p.endsWith(".d.ts");

/** Is this a test file? Tests are leaves of the graph, never its wiring. */
export const isTestFile = (p) => /\.test\.(ts|tsx|js|mjs)$/.test(p);
/** A test file, or a helper only tests import: test-side, not wiring. */
export const isTestSide = (p) => isTestFile(p) || /\.test-helper\.(ts|tsx)$/.test(p) || /[\\/]test[\\/]/.test(p);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (isSource(p)) out.push(p);
  }
  return out;
}

function compilerOptions(repoRoot) {
  const configPath = join(repoRoot, "tsconfig.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config ?? {}, ts.sys, repoRoot).options;
}

/**
 * Every source file under `roots` (src/ and test/ by default, so a test in
 * either is found as an importer), what each imports inside the tree, and who
 * imports each. Paths are absolute; a specifier that resolves outside the
 * tree or into node_modules is dropped.
 */
export function buildImportGraph(repoRoot, roots = [join(repoRoot, "src"), join(repoRoot, "test")]) {
  const files = roots.filter((r) => existsSync(r)).flatMap(walk);
  const inTree = new Set(files.map((f) => resolve(f)));
  const options = compilerOptions(repoRoot);
  const cache = ts.createModuleResolutionCache(repoRoot, (f) => f, options);
  const importsOf = new Map();
  const importersOf = new Map(files.map((f) => [resolve(f), new Set()]));
  for (const file of files) {
    const from = resolve(file);
    const targets = new Set();
    for (const { fileName } of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
      const hit = ts.resolveModuleName(fileName, from, options, ts.sys, cache).resolvedModule;
      if (!hit || hit.isExternalLibraryImport) continue;
      const to = resolve(hit.resolvedFileName);
      if (to !== from && inTree.has(to)) targets.add(to);
    }
    importsOf.set(from, targets);
    for (const to of targets) importersOf.get(to).add(from);
  }
  return { files: [...inTree], importsOf, importersOf };
}

/**
 * Who reaches `target` (a file or a directory) through imports, hop by hop:
 * hop 1 imports it directly, hop 2 imports a hop-1 file, and so on up to
 * `depth`. Files inside the target are never listed. A test file is reached
 * but not followed (nothing imports a test); a test helper is followed to the
 * tests that use it.
 */
export function importersByHop(graph, target, depth) {
  const inside = (p) => p === target || p.startsWith(target + sep);
  const seen = new Set(graph.files.filter(inside));
  let frontier = [...seen];
  const hops = [];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next = [];
    for (const file of frontier) {
      for (const importer of graph.importersOf.get(file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        next.push(importer);
      }
    }
    hops.push(next);
    frontier = next.filter((f) => !isTestFile(f));
  }
  return hops;
}

/** Every test file that imports one of `files`, directly or through test-side
 *  files (helpers, fixtures): the tests to run when those files change. */
export function testsReaching(graph, files) {
  const seen = new Set(files);
  const tests = new Set();
  let frontier = [...files];
  while (frontier.length > 0) {
    const next = [];
    for (const file of frontier) {
      for (const importer of graph.importersOf.get(file) ?? []) {
        if (seen.has(importer) || !isTestSide(importer)) continue;
        seen.add(importer);
        if (isTestFile(importer)) tests.add(importer);
        else next.push(importer);
      }
    }
    frontier = next;
  }
  return [...tests];
}
