// Stamp <distDir>/.builtref with the commit this dist was compiled from, so the
// runtime freshness check (desktop/src/dist-freshness.ts) can tell a dist that
// is behind a `git pull` from one that is current — something the mtime sweep
// alone can miss. See dist-freshness.ts for the full rationale.
//
// Non-fatal by design: if this isn't a git checkout (release tarball build) or
// dist wasn't produced, we simply skip — the runtime then defers to the mtime
// sweep, i.e. pre-existing behavior. A stamp failure must never fail a build.

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const distDir = resolve(process.argv[2] || "dist");
if (!existsSync(distDir)) process.exit(0); // nothing compiled to stamp

let head = "";
try {
  head = execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  process.exit(0); // not a git checkout — leave unstamped, runtime uses mtime
}

if (head) {
  writeFileSync(join(distDir, ".builtref"), head + "\n", "utf-8");
  console.log(`[built-ref] stamped ${distDir}/.builtref = ${head.slice(0, 12)}`);
}
