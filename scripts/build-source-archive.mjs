// Build a source archive from an immutable git object.
//
// `git archive` is the canonical packaging seam for both the rolling updater
// and versioned source releases: it includes exactly the tracked snapshot at
// the requested ref and excludes local build output and dependencies.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function buildSourceArchive(ref, assetPath, prefix) {
  if (!ref || /[\r\n]/.test(ref)) {
    throw new Error("build-source-archive: expected a git ref");
  }
  if (!prefix || prefix.startsWith("/") || prefix.includes("..") || /[\r\n]/.test(prefix)) {
    throw new Error("build-source-archive: expected a safe relative prefix");
  }

  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const resolvedAssetPath = resolve(assetPath);
  mkdirSync(dirname(resolvedAssetPath), { recursive: true });
  execFileSync(
    "git",
    ["archive", "--format=tar.gz", `--prefix=${normalizedPrefix}`, "-o", resolvedAssetPath, ref],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return resolvedAssetPath;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [ref, assetPath, prefix] = process.argv.slice(2);
  if (!ref || !assetPath || !prefix) {
    throw new Error("usage: node scripts/build-source-archive.mjs <ref> <asset-path> <prefix>");
  }
  const built = buildSourceArchive(ref, assetPath, prefix);
  console.log(`[source-archive] ${built}`);
}
