/**
 * Build all @arikernel packages in dependency order.
 *
 * These are local file: dependencies with TypeScript source in src/ and
 * compiled output expected in dist/. npm install links them but doesn't
 * compile — this script ensures dist/ exists before the main app builds.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Dependency order: core first (no deps), then packages that depend on core, etc.
const packages = [
  "core",
  "taint-tracker",
  "audit-log",
  "policy-engine",
  "tool-executors",
  "control-plane",
  "runtime",
  "sidecar",
  "adapters",
];

const ariDir = resolve("packages", "arikernel");
let built = 0;
let skipped = 0;

for (const pkg of packages) {
  const pkgDir = resolve(ariDir, pkg);
  const distIndex = resolve(pkgDir, "dist", "index.js");

  if (!existsSync(resolve(pkgDir, "package.json"))) {
    console.log(`  [ari] skip ${pkg} (no package.json)`);
    skipped++;
    continue;
  }

  if (existsSync(distIndex)) {
    skipped++;
    continue;
  }

  try {
    console.log(`  [ari] building @arikernel/${pkg}...`);
    execSync("npx tsup src/index.ts --format esm --dts", {
      cwd: pkgDir,
      stdio: "pipe",
      timeout: 30_000,
    });
    built++;
  } catch (e) {
    console.warn(`  [ari] WARN: @arikernel/${pkg} build failed: ${e.message}`);
  }
}

if (built > 0) console.log(`  [ari] Built ${built} package(s), ${skipped} already up to date`);
