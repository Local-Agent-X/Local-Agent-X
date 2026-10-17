#!/usr/bin/env node
/**
 * The server↔desktop contract (src/desktop-contract/) is compiled twice: as ESM
 * in the server's build and as CommonJS in desktop/'s, whose tsconfig roots at
 * desktop/src and cannot reach across. So desktop/src/contract/ holds a copy of
 * each contract file, generated here and never hand-edited: a copy that differs
 * from its source fails `npm run build` (check:desktop-contract).
 *
 *   --sync   regenerate every copy from src/desktop-contract/ and remove copies
 *            whose source is gone. The only way desktop/src/contract/ changes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const SOURCE_DIR = join(repoRoot, "src", "desktop-contract");
export const COPY_DIR = join(repoRoot, "desktop", "src", "contract");
const KEPT = new Set(["README.md"]);

const header = (file) =>
  `// GENERATED from src/desktop-contract/${file} by scripts/check-desktop-contract.mjs --sync. Do not edit.\n`;

const sourceFiles = () => readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** The copies that differ from their source, and the copies with no source. */
export function contractDrift() {
  const drift = [];
  const sources = sourceFiles();
  for (const file of sources) {
    const expected = header(file) + readFileSync(join(SOURCE_DIR, file), "utf-8");
    const copy = join(COPY_DIR, file);
    if (!existsSync(copy)) drift.push(`desktop/src/contract/${file} is missing`);
    else if (readFileSync(copy, "utf-8") !== expected) drift.push(`desktop/src/contract/${file} differs from src/desktop-contract/${file}`);
  }
  if (existsSync(COPY_DIR)) {
    for (const file of readdirSync(COPY_DIR)) {
      if (!KEPT.has(file) && !sources.includes(file)) drift.push(`desktop/src/contract/${file} has no source in src/desktop-contract/`);
    }
  }
  return drift;
}

export function syncContract() {
  mkdirSync(COPY_DIR, { recursive: true });
  const sources = sourceFiles();
  for (const file of sources) writeFileSync(join(COPY_DIR, file), header(file) + readFileSync(join(SOURCE_DIR, file), "utf-8"));
  for (const file of readdirSync(COPY_DIR)) {
    if (!KEPT.has(file) && !sources.includes(file)) rmSync(join(COPY_DIR, file));
  }
  return sources.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--sync")) {
    console.log(`check-desktop-contract: copied ${syncContract()} files to desktop/src/contract/`);
  }
  const drift = contractDrift();
  if (drift.length > 0) {
    console.error("The desktop copy of src/desktop-contract/ is out of sync (never hand-edit it; run `node scripts/check-desktop-contract.mjs --sync`):");
    for (const d of drift) console.error("  " + d);
    process.exit(1);
  }
  console.log(`check-desktop-contract: OK (${sourceFiles().length} files)`);
}
