/**
 * Build all @arikernel packages in dependency order.
 *
 * These are local file: dependencies linked into node_modules as junctions
 * (Windows) / symlinks (Unix). We compile in-place at the junction target so
 * the main app's tsc finds dist/index.js + dist/index.d.ts via normal node
 * module resolution.
 *
 * Two passes per package:
 *   1. tsup → emit dist/index.js (no --dts, see note below)
 *   2. tsc  → emit dist/*.d.ts with strict relaxed (--noEmitOnError false)
 *
 * Why not `tsup --dts`? tsup's rollup-plugin-dts hardcodes `baseUrl: "."`,
 * which trips TS 6.0's deprecation gate even with `ignoreDeprecations` set.
 * Splitting js + dts emission sidesteps that.
 *
 * Why relax strict for dts? The arikernel packages were authored against
 * looser settings; they have implicit-any errors that block declaration
 * emission under our root strict config. We force-emit best-effort .d.ts
 * (with `any` filling the gaps) so consumers in src/ get the shape of the
 * public API — which is all the main build needs.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

const packages = [
  "core",
  "taint-tracker",
  "audit-log",
  "policy-engine",
  "tool-executors",
  "runtime",
];

function resolvePackageDir(pkg) {
  const linked = resolve("node_modules", "@arikernel", pkg);
  if (existsSync(linked)) {
    try {
      return realpathSync(linked);
    } catch {
      return linked;
    }
  }
  return resolve("packages", "arikernel", pkg);
}

function latestMtimeMs(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = latestMtimeMs(full);
      if (sub > latest) latest = sub;
    } else if (entry.isFile()) {
      const m = statSync(full).mtimeMs;
      if (m > latest) latest = m;
    }
  }
  return latest;
}

let built = 0;
let skipped = 0;

for (const pkg of packages) {
  const pkgDir = resolvePackageDir(pkg);
  const distJs = resolve(pkgDir, "dist", "index.js");
  const distDts = resolve(pkgDir, "dist", "index.d.ts");

  if (!existsSync(resolve(pkgDir, "package.json"))) {
    console.log(`  [ari] skip ${pkg} (no package.json at ${pkgDir})`);
    skipped++;
    continue;
  }

  const hasJs = existsSync(distJs);
  const hasDts = existsSync(distDts);
  let stale = false;
  if (hasJs && hasDts) {
    // Skip only if dist artifacts are at least as fresh as the newest
    // source file. Without this check, a `git pull` that updates src/
    // leaves stale dist/index.d.ts in place and downstream tsc fails on
    // missing exports — symptom we hit on 2026-05-14 with tool-executors.
    const srcDir = resolve(pkgDir, "src");
    const srcMtime = existsSync(srcDir) ? latestMtimeMs(srcDir) : 0;
    const distMtime = Math.min(statSync(distJs).mtimeMs, statSync(distDts).mtimeMs);
    if (distMtime >= srcMtime) {
      skipped++;
      continue;
    }
    stale = true;
    console.log(`  [ari] @arikernel/${pkg} dist stale — rebuilding`);
  }

  try {
    if (!hasJs || stale) {
      console.log(`  [ari] tsup @arikernel/${pkg} → dist/index.js`);
      execSync("npx tsup src/index.ts --format esm", {
        cwd: pkgDir,
        stdio: "pipe",
        timeout: 60_000,
      });
    }

    if (!hasDts || stale) {
      console.log(`  [ari] tsc @arikernel/${pkg} → dist/*.d.ts`);
      execSync(
        "npx tsc -p . --emitDeclarationOnly --declaration --noEmitOnError false --strict false --noImplicitAny false --strictNullChecks false",
        {
          cwd: pkgDir,
          stdio: "pipe",
          timeout: 90_000,
        },
      );
    }
    built++;
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : "";
    const stdout = e.stdout ? e.stdout.toString() : "";
    if (existsSync(distDts) || existsSync(distJs)) {
      // tsc with --noEmitOnError false exits non-zero but still emits files
      // we want — treat as success when artifacts exist.
      try {
        if (existsSync(distJs) && existsSync(distDts) && statSync(distDts).size > 0) {
          built++;
          continue;
        }
      } catch {}
    }
    console.warn(`  [ari] WARN: @arikernel/${pkg} build failed: ${e.message}`);
    if (stderr) console.warn(`         stderr: ${stderr.split("\n").slice(0, 3).join(" | ")}`);
    if (stdout) console.warn(`         stdout: ${stdout.split("\n").slice(0, 3).join(" | ")}`);
  }
}

if (built > 0) {
  console.log(`  [ari] Built ${built} package(s), ${skipped} already up to date`);
}
