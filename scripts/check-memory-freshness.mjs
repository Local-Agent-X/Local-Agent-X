#!/usr/bin/env node
/**
 * Memory-freshness lint — flags rot in the persistent Claude-Code memory files
 * for THIS repo (the `*.md` notes under ~/.claude/projects/<repo>/memory/).
 *
 * Those notes reference repo code by path (and link siblings by [[slug]]), but
 * unlike the product's own memory subsystem (src/memory/, which already decays +
 * invalidates), they have no freshness mechanism: when a file moves or is
 * deleted, the reference silently rots and misleads the next session. This
 * checks every repo-relative path reference against the working tree and every
 * [[link]] against the memory dir, and reports the dead ones.
 *
 * Precision: a path is only checked when its FIRST segment is a real top-level
 * dir of THIS repo and the reference starts at a path boundary (so `app/src/x`
 * or `workers/broker/src/x` from a sibling repo aren't mis-read as `src/x`).
 * Limitation: a note about ANOTHER repo that shares a top-level dir name
 * (e.g. `packages/` or `docs/`) can still false-flag — those refs can't be
 * told apart from this repo's without knowing the other repo's tree.
 *
 * Report-only (exit 0) by default — these notes live outside the repo, so this
 * never gates a commit and is NOT wired into the build/CI. Pass --strict to exit
 * non-zero when stale references are found (for an opt-in local hook).
 *
 * Run:  npm run memory:check
 *       node scripts/check-memory-freshness.mjs --memory-dir <path> --strict
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const strict = args.includes("--strict");

const repoRoot = opt("--repo") || process.cwd();
// Claude-Code stores a project's memory under ~/.claude/projects/<cwd with
// slashes turned to dashes>/memory. Derive that by default; allow an override.
const defaultMemoryDir = join(homedir(), ".claude", "projects", repoRoot.replace(/\//g, "-"), "memory");
const memoryDir = opt("--memory-dir") || defaultMemoryDir;

if (!existsSync(memoryDir)) {
  console.error(`memory dir not found: ${memoryDir}\n(pass --memory-dir <path> to point at it)`);
  process.exit(strict ? 1 : 0);
}

// Real top-level dirs of this repo — only paths rooted at one of these are ours
// to verify; anything else is a sibling-repo path we can't (and shouldn't) check.
const repoTopDirs = new Set(
  readdirSync(repoRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name),
);

// A path token: starts at a non-path boundary (so a sibling-repo prefix like
// `app/` or `workers/broker/` is captured whole, not stripped to its `src/`
// tail), has at least one `/`, and ends in a file extension.
const PATH_RE = /(?<![\w./@-])([A-Za-z0-9_][\w.@-]*(?:\/[\w.@-]+)+\.[A-Za-z0-9]+)/g;
const LINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;
// A path on a line that mentions deletion is probably an intentional historical
// reference ("src/foo REMOVED"), not accidental rot — tag it instead of flagging.
const INTENT_RE = /\b(remov|delet|dead|gone|deprecat|former|was at|used to|no longer|retired|killed)/i;

const memoryFiles = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
const memorySlugs = new Set(memoryFiles.map((f) => f.replace(/\.md$/, "")));

let stale = 0, intentional = 0, dangling = 0, pathsChecked = 0;
const report = [];

for (const file of memoryFiles) {
  const text = readFileSync(join(memoryDir, file), "utf-8");
  const lines = text.split("\n");
  const fileFindings = [];

  lines.forEach((line, idx) => {
    for (const m of line.matchAll(PATH_RE)) {
      const ref = m[1].replace(/[.,;:)\]]+$/, ""); // strip trailing punctuation
      if (!repoTopDirs.has(ref.split("/")[0])) continue; // sibling-repo path — not ours to check
      pathsChecked++;
      if (existsSync(join(repoRoot, ref))) continue;
      if (INTENT_RE.test(line)) { intentional++; fileFindings.push({ kind: "intentional", ref, ln: idx + 1 }); }
      else { stale++; fileFindings.push({ kind: "stale", ref, ln: idx + 1 }); }
    }
    for (const m of line.matchAll(LINK_RE)) {
      if (memorySlugs.has(m[1])) continue;
      dangling++; fileFindings.push({ kind: "dangling", ref: `[[${m[1]}]]`, ln: idx + 1 });
    }
  });

  if (fileFindings.length) report.push({ file, findings: fileFindings });
}

console.log(`\nmemory-freshness — ${memoryFiles.length} notes, ${pathsChecked} path refs checked`);
console.log(`  dir: ${memoryDir}\n`);

for (const { file, findings } of report) {
  console.log(file);
  for (const f of findings) {
    const tag = f.kind === "stale" ? "STALE     " : f.kind === "intentional" ? "intentional?" : "dangling  ";
    console.log(`  ${tag} L${f.ln}  ${f.ref}`);
  }
}

console.log(`\n${stale} stale path ref(s), ${intentional} likely-intentional, ${dangling} dangling link(s)`);
if (stale === 0) console.log("✅ no accidental rot");
process.exit(strict && stale > 0 ? 1 : 0);
