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
 *   - importers: distinct NON-TEST files outside the dir that import it,
 *     statically or by import() (the real "how wired-in is this" signal; 0 ⇒ dead/superseded),
 *     from the compiler's import graph (scripts/lib/import-graph.mjs).
 *   - files / size tier: file count + an S/M/L/XL bucket of CODE lines (NOT
 *     a raw count, so a few-line edit doesn't flip the build gate — only
 *     crossing a tier does).
 *   - oversized: non-test files and functions over the code-size caps.
 * And, for the whole tree, what is nearing those caps (the warning band).
 * Sizes are code lines, measured by the structure kit's own counter
 * (src/app-scaffold/kit/code-size.mjs) with the caps check-source-hygiene.mjs
 * holds this repo to: one implementation for the gate and the map.
 *
 * STABLE BY DESIGN: the output only changes on events worth re-reading the doc
 * for — a dir added/removed, a wiring count change, a dir going dead/undead, a
 * file or function crossing a cap or moving ten code lines inside the warning
 * band, or a size tier flip. That is what lets `npm run build` gate on it
 * (--check) without failing on every trivial commit.
 *
 *   Regenerate:  npm run docs:map        (node scripts/gen-codebase-map.mjs)
 *   Verify:      npm run check:codebase-map   (--check; runs inside npm build)
 *   Who imports: npm run deps -- <file or dir> [--depth N]   (scripts/deps.mjs)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImportGraph } from "./lib/import-graph.mjs";
import { LAX_SIZE_LIMITS } from "./check-source-hygiene.mjs";
import { bandOf, measureSource, nearingSection, sizeItems } from "../src/app-scaffold/kit/code-size.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const OUT = join(REPO_ROOT, "docs/codebase-map.md");

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

function sizeTier(loc) {
  if (loc < 250) return "S";
  if (loc < 1000) return "M";
  if (loc < 3000) return "L";
  return "XL";
}

// The top-level src/ dir a file sits in, or null for a loose src/*.ts file.
function topDirOf(abs) {
  const parts = relative(SRC_ROOT, abs).split(sep);
  return parts.length > 1 ? parts[0] : null;
}

// ── Gather the tree ────────────────────────────────────────────────────────
const topDirs = readdirSync(SRC_ROOT)
  .filter((n) => statSync(join(SRC_ROOT, n)).isDirectory())
  .sort();

const allFiles = walk(SRC_ROOT).filter((p) => isSource(p.split(sep).pop()));
const graph = buildImportGraph(REPO_ROOT, [SRC_ROOT]);

// Per-dir aggregates. `loc` is code lines; `over` the items past a size cap.
const dirData = new Map(
  topDirs.map((d) => [d, { files: 0, loc: 0, over: [], importers: new Set() }])
);

// Loose top-level src/*.ts files (not in any subdir) — index.ts, types.ts,
// server-context.ts, tool-executor.ts live here and matter for navigation.
const looseFiles = [];
const sized = []; // every non-test file and function, for the size sections

for (const abs of allFiles) {
  const rel = relative(SRC_ROOT, abs);
  const parts = rel.split(sep);
  const name = parts[parts.length - 1];
  const items = isTest(name) ? [] : sizeItems(relative(REPO_ROOT, abs).split(sep).join("/"), measureSource(abs, readFileSync(abs, "utf-8"), REPO_ROOT));
  sized.push(...items);
  const loc = items[0]?.size ?? 0;
  const over = items.filter((it) => bandOf(it, LAX_SIZE_LIMITS) === "over");

  // Tally THIS file as an importer of whatever dirs it points at (tests don't
  // count toward "wired into the running system").
  if (!isTest(name)) {
    const fromDir = parts.length > 1 ? parts[0] : null; // self-dir, to exclude self-imports
    for (const target of graph.importsOf.get(resolve(abs)) ?? []) {
      const top = topDirOf(target);
      if (top && top !== fromDir && dirData.has(top)) dirData.get(top).importers.add(rel);
    }
  }

  if (parts.length === 1) {
    if (!isTest(name)) looseFiles.push({ name, loc, over });
    continue;
  }

  const d = dirData.get(parts[0]);
  if (isTest(name)) continue; // tests excluded from size/file/oversized accounting
  d.files += 1;
  d.loc += loc;
  d.over.push(...over);
}

// ── Build the rows ─────────────────────────────────────────────────────────
const rows = topDirs.map((d) => {
  const x = dirData.get(d);
  const importers = x.importers.size;
  const entry = RUNTIME_ENTRYPOINTS.get(d);
  const dead = importers === 0 && !entry;
  return { dir: d, importers, files: x.files, tier: sizeTier(x.loc), over: x.over, dead, entry };
});

// Sort: live dirs by importer count desc, then name; dead dirs sink to a
// dedicated section so the main table reads as "the live system."
const live = rows.filter((r) => !r.dead).sort((a, b) => b.importers - a.importers || a.dir.localeCompare(b.dir));
const dead = rows.filter((r) => r.dead).sort((a, b) => a.dir.localeCompare(b.dir));
// Membership, sorted by name, so a listed item changing size doesn't churn the doc.
const overRows = [...rows.flatMap((r) => r.over), ...looseFiles.flatMap((f) => f.over)].map((it) => it.key).sort();
const nearing = nearingSection(sized, LAX_SIZE_LIMITS);
const { maxCode, warnCode, maxFn, warnFn } = LAX_SIZE_LIMITS;

// ── Render markdown ────────────────────────────────────────────────────────
const totalFiles = rows.reduce((n, r) => n + r.files, 0);
const out = [];
out.push("# Codebase map (generated — do not edit)");
out.push("");
out.push("Auto-derived structural facts about `src/`, regenerated by");
out.push("[`scripts/gen-codebase-map.mjs`](../scripts/gen-codebase-map.mjs). **Do not hand-edit** —");
out.push("run `npm run docs:map` to refresh; `npm run build` fails if this file is stale.");
out.push("");
out.push("This file owns the facts that *drift* (importer counts, dead-code, sizes).");
out.push("[ARCHITECTURE.md](../ARCHITECTURE.md) owns the *meaning* (which file does what, and why).");
out.push("");
out.push("**Definitions** — *Importers*: distinct non-test files outside the dir that import it,");
out.push(`statically or by \`import()\` (0 ⇒ no live wiring). *Size*: S <250 · M <1k · L <3k · XL ≥3k non-test`);
out.push(`code lines (comments and blank lines are free; tiers, not raw counts, so trivial edits don't churn this file).`);
out.push(`*Oversized*: non-test files over ${maxCode} code lines and functions (\`file#function\`) over ${maxFn} of`);
out.push(`their own — the source-hygiene caps; each is held at its size in \`.code-size-ratchet\`.`);
out.push("");
out.push(`**Totals:** ${rows.length} top-level dirs · ${live.length} live · ${dead.length} with no live importer · ${totalFiles} non-test source files · ${overRows.length} oversized · ${nearing.length} nearing the size cap.`);
out.push("");
out.push("## Live directories (by how wired-in they are)");
out.push("");
out.push("| Directory | Importers | Files | Size | Oversized |");
out.push("|---|--:|--:|:--:|--:|");
for (const r of live) {
  const note = r.entry ? " *(entrypoint)*" : "";
  out.push(`| \`src/${r.dir}/\`${note} | ${r.importers} | ${r.files} | ${r.tier} | ${r.over.length || ""} |`);
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

out.push("## Oversized");
out.push("");
out.push("Over a code-size cap, held at their recorded size in `.code-size-ratchet` (they may only shrink).");
out.push("Burn-down targets: find the job that grew and move it to a module named after it.");
out.push("");
out.push(overRows.length ? overRows.map((k) => `- \`${k}\``).join("\n") : "None.");
out.push("");
out.push("## Nearing the size cap");
out.push("");
out.push(`In the warning band (a file over ${warnCode} code lines, a function over ${warnFn} of its own), largest first,`);
out.push("sizes in tens. Before adding to one, find the job that grew and move it to a module named after that");
out.push("job. Comments are free: never cut them to fit.");
out.push("");
out.push(nearing.length ? nearing.join("\n") : "None.");
out.push("");

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
  console.log(`check-codebase-map: OK (${rows.length} dirs, ${overRows.length} oversized, ${nearing.length} nearing the size cap)`);
} else {
  writeFileSync(OUT, content);
  console.log(`Wrote ${relative(REPO_ROOT, OUT)} — ${rows.length} dirs, ${dead.length} dead, ${overRows.length} oversized, ${nearing.length} nearing the size cap.`);
}
