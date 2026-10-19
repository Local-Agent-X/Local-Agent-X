#!/usr/bin/env node
/**
 * Vendored-code gate for src/app-scaffold/kit/: the structure kit Local Agent X
 * drops into every project its agents build (the check scripts and the seal
 * test). Its source of truth is the /new-project skill, which serves every repo
 * on the machine, so the copy here is never hand-edited.
 *
 * The copy drifts two ways, and this catches both:
 *   1. Hand edits here. kit/UPSTREAM.json records each file's upstream path and
 *      the sha256 of its text (line endings folded to LF). A changed hash fails.
 *   2. Upstream moving on. When the skill is found ($NEW_PROJECT_SKILL_DIR, else
 *      ~/.claude/skills/new-project), each copy must equal its upstream file.
 *      Without the skill (CI, another machine) this half is skipped, loudly.
 *
 *   --sync   copy every file from upstream, then record the hashes. The only
 *            way kit/ should change.
 * Runs in `npm run build` (check:kit-sync).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const KIT_DIR = join(repoRoot, "src", "app-scaffold", "kit");
const manifestPath = join(KIT_DIR, "UPSTREAM.json");

/** Vendored name → path inside the skill. The seal tests are stored with a .txt
 *  suffix so neither vitest, pytest nor tsc treats a template as this repo's code. */
export const KIT_FILES = {
  "project-languages.mjs": "scripts/project-languages.mjs",
  "codebase-map.mjs": "scripts/codebase-map.mjs",
  "code-size.mjs": "scripts/code-size.mjs",
  "code-size-cfamily.mjs": "scripts/code-size-cfamily.mjs",
  "code-size-python.mjs": "scripts/code-size-python.mjs",
  "check-code-size.mjs": "scripts/check-code-size.mjs",
  "check-doc-paths.mjs": "scripts/check-doc-paths.mjs",
  "check-module-owners.mjs": "scripts/check-module-owners.mjs",
  "check-structure.mjs": "scripts/check-structure.mjs",
  "code-refs.mjs": "scripts/code-refs.mjs",
  "typescript-api.mjs": "scripts/typescript-api.mjs",
  "module-seals.test.ts.txt": "assets/module-seals.test.ts",
  "test_module_seals.py.txt": "assets/test_module_seals.py",
};

const lf = (text) => text.replace(/\r\n/g, "\n");
const readLf = (path) => lf(readFileSync(path, "utf-8"));
const hashOf = (text) => createHash("sha256").update(text).digest("hex");

/** The skill checkout to compare against. NEW_PROJECT_SKILL_DIR, when set, is
 *  the one place looked at (a path with no skill there means "skip the
 *  upstream half", said aloud below — for a build while the skill is being
 *  edited); otherwise the user's installed skill. */
export function findUpstream() {
  const env = process.env.NEW_PROJECT_SKILL_DIR;
  const candidates = env !== undefined ? [env] : [join(homedir(), ".claude", "skills", "new-project")];
  return candidates.find((dir) => existsSync(join(dir, "scripts", "codebase-map.mjs"))) ?? null;
}

/** Every way the copy is wrong: a missing file, a hash that is not the recorded
 *  one, or (with the skill present) text that is not upstream's. */
export function kitDrift(upstream = findUpstream()) {
  const drift = [];
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : {};
  for (const [name, upstreamRel] of Object.entries(KIT_FILES)) {
    const copy = join(KIT_DIR, name);
    if (!existsSync(copy)) { drift.push(`kit/${name} is missing`); continue; }
    const text = readLf(copy);
    if (manifest[name]?.sha256 !== hashOf(text)) drift.push(`kit/${name} does not match the hash in UPSTREAM.json (hand-edited?)`);
    if (upstream && readLf(join(upstream, upstreamRel)) !== text) drift.push(`kit/${name} differs from the skill's ${upstreamRel}`);
  }
  return drift;
}

export function syncKit(upstream = findUpstream()) {
  if (!upstream) throw new Error("the /new-project skill was not found: set NEW_PROJECT_SKILL_DIR");
  mkdirSync(KIT_DIR, { recursive: true });
  const manifest = {};
  for (const [name, upstreamRel] of Object.entries(KIT_FILES)) {
    const text = readLf(join(upstream, upstreamRel));
    writeFileSync(join(KIT_DIR, name), text);
    manifest[name] = { upstream: upstreamRel, sha256: hashOf(text) };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return Object.keys(manifest).length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const upstream = findUpstream();
  if (process.argv.includes("--sync")) console.log(`check-kit-sync: copied ${syncKit(upstream)} files from ${upstream}`);
  const drift = kitDrift(upstream);
  if (drift.length > 0) {
    console.error("src/app-scaffold/kit/ is out of sync (never hand-edit it; change the /new-project skill, then `node scripts/check-kit-sync.mjs --sync`):");
    for (const d of drift) console.error("  " + d);
    process.exit(1);
  }
  console.log(`check-kit-sync: OK (${Object.keys(KIT_FILES).length} files${upstream ? "" : "; skill not found, upstream comparison skipped"})`);
}
