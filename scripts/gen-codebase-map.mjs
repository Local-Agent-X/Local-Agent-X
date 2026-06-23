#!/usr/bin/env node
/**
 * Generate docs/codebase-map.md — the drift-proof structural map of src/.
 *
 * WHY THIS EXISTS: ARCHITECTURE.md is a hand-written narrative ("which file
 * owns X"). The *facts* it leaned on — per-directory importer counts and
 * "this dir is dead / deprecated" labels — rot fast. (The context-manager
 * entry went stale within a week when the context-consolidation work rewired
 * it.) Those facts are computable, so this script computes them from the tree
 * and ARCHITECTURE.md links here for the live numbers instead of hard-coding
 * them. Same idea as gen-agent-capabilities.ts: generate what drifts, curate
 * the prose.
 *
 * WHAT IT REPORTS, per top-level src/ directory:
 *   - importers: distinct NON-TEST files outside the dir that statically import
 *     it (the real "how wired-in is this" signal; 0 ⇒ dead/superseded).
 *   - files / size tier: file count + an S/M/L/XL bucket (NOT raw LOC, so a
 *     few-line edit doesn't flip the build gate — only crossing a tier does).
 *   - god files: count of non-test files over the 400-LOC source-hygiene limit.
 *
 * STABLE BY DESIGN: the output only changes on events worth re-reading the doc
 * for — a dir added/removed, a wiring count change, a dir going dead/undead, a
 * file crossing 400 LOC, or a size tier flip. That is what lets `npm run build`
 * gate on it (--check) without failing on every trivial commit.
 *
 *   Regenerate:  npm run docs:map        (node scripts/gen-codebase-map.mjs)
 *   Verify:      npm run check:codebase-map   (--check; runs inside npm build)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const OUT = join(REPO_ROOT, "docs/codebase-map.md");

// Matches the LOC ceiling enforced by scripts/check-source-hygiene.mjs.
const GOD_LOC = 400;

// Dirs reached at runtime through a non-static path (process boot, dynamic
// import, string-keyed loader) so a 0-importer count is NOT evidence they are
// dead. Keep this list tiny and justified — it is the one curated escape hatch.
const RUNTIME_ENTRYPOINTS = new Map([
  ["server", "booted by src/index.ts via the HTTP boot sequence"],
]);

const isTest = (name) => /\.test\.(ts|tsx|js|mjs)$/.test(name);
const isSource = (name) => /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts");

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function countLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function sizeTier(loc) {
  if (loc < 250) return "S";
  if (loc < 1000) return "M";
  if (loc < 3000) return "L";
  return "XL";
}

// All import/export/require specifiers in a file (static + dynamic).
const SPEC_RES = [
  /\bfrom\s+["']([^"']+)["']/g,        // import ... from "x" / export ... from "x"
  /\bimport\s+["']([^"']+)["']/g,      // side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']/g, // dynamic import("x")
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];
function importSpecs(text) {
  const specs = new Set();
  for (const re of SPEC_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) specs.add(m[1]);
  }
  return specs;
}

// Resolve a relative specifier to the top-level src/ dir it lands in, or null.
function specToTopDir(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare pkg (npm, @arikernel/*) — not a src dir
  const abs = resolve(dirname(fromFile), spec);
  const rel = relative(SRC_ROOT, abs);
  if (rel.startsWith("..") || rel === "") return null; // outside src/
  const top = rel.split(sep)[0];
  // A top-level loose file (e.g. "tool-executor.js") isn't a directory.
  return top.includes(".") ? null : top;
}

// ── Gather the tree ────────────────────────────────────────────────────────
const topDirs = readdirSync(SRC_ROOT)
  .filter((n) => statSync(join(SRC_ROOT, n)).isDirectory())
  .sort();

const allFiles = walk(SRC_ROOT).filter((p) => isSource(p.split(sep).pop()));

// Per-dir aggregates.
const dirData = new Map(
  topDirs.map((d) => [d, { files: 0, loc: 0, gods: [], importers: new Set() }])
);

// Loose top-level src/*.ts files (not in any subdir) — index.ts, types.ts,
// server-context.ts, tool-executor.ts live here and matter for navigation.
const looseFiles = [];

for (const abs of allFiles) {
  const rel = relative(SRC_ROOT, abs);
  const parts = rel.split(sep);
  const name = parts[parts.length - 1];
  const text = readFileSync(abs, "utf-8");
  const loc = countLines(text);

  // Tally THIS file as an importer of whatever dirs it points at (tests don't
  // count toward "wired into the running system").
  if (!isTest(name)) {
    const fromDir = parts.length > 1 ? parts[0] : null; // self-dir, to exclude self-imports
    const seen = new Set();
    for (const spec of importSpecs(text)) {
      const top = specToTopDir(abs, spec);
      if (top && top !== fromDir && dirData.has(top) && !seen.has(top)) {
        seen.add(top);
        dirData.get(top).importers.add(rel);
      }
    }
  }

  if (parts.length === 1) {
    if (!isTest(name)) looseFiles.push({ name, loc });
    continue;
  }

  const d = dirData.get(parts[0]);
  if (isTest(name)) continue; // tests excluded from size/file/god accounting
  d.files += 1;
  d.loc += loc;
  if (loc > GOD_LOC) d.gods.push({ rel, loc });
}

// ── Build the rows ─────────────────────────────────────────────────────────
const rows = topDirs.map((d) => {
  const x = dirData.get(d);
  const importers = x.importers.size;
  const entry = RUNTIME_ENTRYPOINTS.get(d);
  const dead = importers === 0 && !entry;
  return { dir: d, importers, files: x.files, tier: sizeTier(x.loc), gods: x.gods, dead, entry };
});

// Sort: live dirs by importer count desc, then name; dead dirs sink to a
// dedicated section so the main table reads as "the live system."
const live = rows.filter((r) => !r.dead).sort((a, b) => b.importers - a.importers || a.dir.localeCompare(b.dir));
const dead = rows.filter((r) => r.dead).sort((a, b) => a.dir.localeCompare(b.dir));
const godRows = rows.flatMap((r) => r.gods).sort((a, b) => b.loc - a.loc);

// ── Render markdown ────────────────────────────────────────────────────────
const totalFiles = rows.reduce((n, r) => n + r.files, 0);
const out = [];
out.push("# Codebase map (generated — do not edit)");
out.push("");
out.push("Auto-derived structural facts about `src/`, regenerated by");
out.push("[`scripts/gen-codebase-map.mjs`](../scripts/gen-codebase-map.mjs). **Do not hand-edit** —");
out.push("run `npm run docs:map` to refresh; `npm run build` fails if this file is stale.");
out.push("");
out.push("This file owns the facts that *drift* (importer counts, dead-code, god files).");
out.push("[ARCHITECTURE.md](../ARCHITECTURE.md) owns the *meaning* (which file does what, and why).");
out.push("");
out.push("**Definitions** — *Importers*: distinct non-test files outside the dir that statically");
out.push(`import it (0 ⇒ no live wiring). *Size*: S <250 · M <1k · L <3k · XL ≥3k non-test LOC`);
out.push(`(tiers, not raw lines, so trivial edits don't churn this file). *God*: non-test files`);
out.push(`over ${GOD_LOC} LOC (the source-hygiene ceiling).`);
out.push("");
out.push(`**Totals:** ${rows.length} top-level dirs · ${live.length} live · ${dead.length} with no live importer · ${totalFiles} non-test source files · ${godRows.length} god files (>${GOD_LOC} LOC).`);
out.push("");
out.push("## Live directories (by how wired-in they are)");
out.push("");
out.push("| Directory | Importers | Files | Size | God files |");
out.push("|---|--:|--:|:--:|--:|");
for (const r of live) {
  const note = r.entry ? " *(entrypoint)*" : "";
  out.push(`| \`src/${r.dir}/\`${note} | ${r.importers} | ${r.files} | ${r.tier} | ${r.gods.length || ""} |`);
}
out.push("");

out.push("## No live importer (dead / superseded candidates)");
out.push("");
if (dead.length === 0) {
  out.push("_None — every directory has at least one live importer._");
} else {
  out.push("Zero non-test importers. Likely superseded; confirm before tracing into them.");
  out.push("See ARCHITECTURE.md's \"Looks canonical, isn't\" table for the curated verdicts.");
  out.push("");
  out.push("| Directory | Files | Size |");
  out.push("|---|--:|:--:|");
  for (const r of dead) out.push(`| \`src/${r.dir}/\` | ${r.files} | ${r.tier} |`);
}
out.push("");

if (looseFiles.length) {
  looseFiles.sort((a, b) => a.name.localeCompare(b.name));
  out.push("## Top-level `src/` files");
  out.push("");
  out.push("Loose files at the root of `src/` (entry + cross-cutting surfaces).");
  out.push("");
  out.push("| File | Size |");
  out.push("|---|:--:|");
  for (const f of looseFiles) out.push(`| \`src/${f.name}\` | ${sizeTier(f.loc)} |`);
  out.push("");
}

if (godRows.length) {
  out.push(`## God files (> ${GOD_LOC} LOC)`);
  out.push("");
  out.push("Burn-down targets for `/refactor-godfiles`. Membership only (not exact LOC),");
  out.push("so a god file growing a little doesn't churn this doc — only crossing the");
  out.push(`${GOD_LOC}-line line does.`);
  out.push("");
  out.push("| File | Size |");
  out.push("|---|:--:|");
  for (const g of godRows) out.push(`| \`src/${g.rel.split(sep).join("/")}\` | ${sizeTier(g.loc)} |`);
  out.push("");
}

const content = out.join("\n") + "\n";

// ── Emit or check ──────────────────────────────────────────────────────────
const checkMode = process.argv.includes("--check");
if (checkMode) {
  let existing = "";
  try { existing = readFileSync(OUT, "utf-8"); } catch { /* missing ⇒ stale */ }
  if (existing !== content) {
    console.error("docs/codebase-map.md is stale (or missing). Run: npm run docs:map");
    process.exit(1);
  }
  console.log(`check-codebase-map: OK (${rows.length} dirs, ${godRows.length} god files)`);
} else {
  writeFileSync(OUT, content);
  console.log(`Wrote ${relative(REPO_ROOT, OUT)} — ${rows.length} dirs, ${dead.length} dead, ${godRows.length} god files.`);
}
