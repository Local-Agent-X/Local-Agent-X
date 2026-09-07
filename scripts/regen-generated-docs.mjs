#!/usr/bin/env node
/**
 * Regenerate the docs that are generated from source but committed to the repo.
 *
 * WHY THIS EXISTS: `npm run build` byte-compares docs/codebase-map.md against
 * freshly generated content, and the rolling updater runs `npm run build` on
 * every candidate. So a push that adds a source file without regenerating the
 * map produces a commit that cannot build — and before CI gated publication,
 * that rejected the update on every installed machine at once. The generators
 * are fast and deterministic; nothing is gained by making a human remember to
 * run them.
 *
 * Two modes:
 *   (default)  regenerate and `git add` anything that changed — what the
 *              pre-commit hook runs, so a commit can't be born stale.
 *   --check    regenerate and FAIL if the tree changed — what CI runs.
 *
 * The hook path only fires when staged files could actually move a generated
 * doc, so an unrelated commit pays nothing.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Each generated doc, the command that produces it, and why it can drift.
const GENERATED = [
  {
    doc: "docs/codebase-map.md",
    run: ["node", ["scripts/gen-codebase-map.mjs"]],
    // Directory membership, importer counts and size tiers — any added,
    // removed or newly-imported source file can move it.
    movedBy: (path) => path.startsWith("src/"),
  },
  {
    doc: "docs/agent-capabilities.md",
    run: ["npx", ["tsx", "scripts/gen-agent-capabilities.ts"]],
    movedBy: (path) => path.startsWith("src/") || path === "package.json",
  },
];

const git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" });

function stagedPaths() {
  return git(["diff", "--cached", "--name-only"]).split("\n").map((s) => s.trim()).filter(Boolean);
}

function isDirty(doc) {
  // --quiet exits 1 when the path differs; execFileSync throws on non-zero.
  try {
    git(["diff", "--quiet", "--", doc]);
    return false;
  } catch {
    return true;
  }
}

const checkMode = process.argv.includes("--check");
const hookMode = process.argv.includes("--staged-only");

const staged = hookMode ? stagedPaths() : null;
const targets = GENERATED.filter((g) => !hookMode || staged.some((p) => g.movedBy(p)));

if (targets.length === 0) process.exit(0);

const changed = [];
for (const target of targets) {
  const [cmd, args] = target.run;
  execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: "pipe", shell: process.platform === "win32" });
  if (isDirty(target.doc)) changed.push(target.doc);
}

if (changed.length === 0) {
  if (!hookMode) console.log(`[generated-docs] up to date (${targets.map((t) => t.doc).join(", ")})`);
  process.exit(0);
}

if (checkMode) {
  console.error(`[generated-docs] STALE: ${changed.join(", ")}`);
  console.error("[generated-docs] Run: npm run docs:generated");
  process.exit(1);
}

git(["add", "--", ...changed]);
console.log(`[generated-docs] regenerated and staged: ${changed.join(", ")}`);
