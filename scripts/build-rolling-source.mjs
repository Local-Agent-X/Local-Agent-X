// Build the per-commit ROLLING SOURCE asset the in-app updater verifies.
//
// The rolling OTA channel (src/ota-update.ts downloadMainTarball) resolves
// `main` → an immutable commit sha, then PREFERS a published, checksum-verified
// asset
//     releases/download/rolling/lax-source-<sha>.tar.gz   (+ .sha256 sidecar)
// over GitHub's on-demand archive/<sha>.tar.gz — whose bytes are NOT
// byte-stable, so they can't be pre-hashed. This script produces exactly that
// asset pair, so the SHA-256 the app checks is the SHA-256 of the bytes it
// downloads. The publishing side is .github/workflows/rolling-source.yml.
//
// Contract with the verifier (assertSha256 + applyUpdate in src/ota-update.ts):
//   • asset name MUST be lax-source-<full-40-char-sha>.tar.gz — the app builds
//     this name from the GitHub commits API `sha`, which is the full 40-char
//     sha, so a short sha would never match.
//   • the sidecar is <asset>.sha256 in `sha256sum` format ("<hash>  <name>");
//     assertSha256 reads the first whitespace-delimited token.
//   • the tarball MUST extract cleanly with `tar xzf … --strip-components=1`
//     (exactly one top-level prefix dir), matching applyUpdate's extract.
//
// This archive script itself uses only Node builtins + git. The publishing
// workflow compiles desktop/dist first, then this script overlays that output
// onto the tracked source archive so old updater builds can bootstrap the fix.
//
// Usage: node scripts/build-rolling-source.mjs [<sha>] [<outDir>] [--require-desktop-dist]
//   defaults: sha = `git rev-parse HEAD`, outDir = ./rolling-dist

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { buildSourceArchive } from "./build-source-archive.mjs";

// Name + schema are the client contract; src/ota-rolling-pointer.ts parses this.
export const ROLLING_POINTER_ASSET = "rolling-source-latest.json";

/**
 * Write the pointer naming the newest CI-PROVEN commit.
 *
 * Published only after that commit's source asset is uploaded, so the pointer
 * can never name a commit a client cannot download. The workflow additionally
 * refuses to move it to a non-descendant, so it never walks backwards.
 */
export function buildRollingPointer(sha, subject, outDir) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`build-rolling-source: expected a full 40-char commit sha, got: ${JSON.stringify(sha)}`);
  }
  mkdirSync(outDir, { recursive: true });
  const pointerPath = join(outDir, ROLLING_POINTER_ASSET);
  const pointer = {
    schemaVersion: 1,
    commit: sha,
    subject: String(subject || "").split(/[\r\n]/)[0],
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(pointerPath, JSON.stringify(pointer, null, 2) + "\n");
  return { pointerPath, pointer };
}

export function buildRollingSource(sha, outDir, opts = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`build-rolling-source: expected a full 40-char commit sha, got: ${JSON.stringify(sha)}`);
  }
  mkdirSync(outDir, { recursive: true });

  const assetName = `lax-source-${sha}.tar.gz`;
  const assetPath = join(outDir, assetName);

  const prefix = `lax-source-${sha}`;
  const desktopDistDir = resolve(opts.desktopDistDir || "desktop/dist");
  const hasDesktopBuild = existsSync(join(desktopDistDir, "main.js"));
  if (opts.requireDesktopDist && !hasDesktopBuild) {
    throw new Error(`build-rolling-source: required desktop build is missing: ${join(desktopDistDir, "main.js")}`);
  }

  if (!hasDesktopBuild) {
    buildSourceArchive(sha, assetPath, prefix);
  } else {
    // Existing installed updaters validate/build server source but cannot yet
    // compile Electron source. Overlay the CI-built desktop output into the
    // immutable tracked archive so this updater repair can bootstrap itself.
    const stageDir = mkdtempSync(join(tmpdir(), "lax-rolling-source-"));
    try {
      const tarPath = join(stageDir, "payload.tar");
      execFileSync("git", ["archive", "--format=tar", `--prefix=${prefix}/`, "-o", tarPath, sha]);
      const stagedDesktop = join(stageDir, prefix, "desktop", "dist");
      mkdirSync(join(stageDir, prefix, "desktop"), { recursive: true });
      cpSync(desktopDistDir, stagedDesktop, { recursive: true });
      // Run from stageDir with relative names: GNU tar reads the colon in an
      // absolute Windows path (`-rf C:\…`) as a remote rsh host and dies with
      // "Cannot connect to C:", which made this publisher — and the contract
      // test that imports it — unrunnable anywhere but CI.
      execFileSync("tar", ["-rf", "payload.tar", `${prefix}/desktop/dist`], { cwd: stageDir });
      writeFileSync(assetPath, gzipSync(readFileSync(tarPath)));
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  const buf = readFileSync(assetPath);
  const hash = createHash("sha256").update(buf).digest("hex");
  // `sha256sum` format: "<hash>  <filename>". assertSha256 takes the first token,
  // so the trailing name is ignored on verify but keeps the sidecar self-describing.
  const sidecarPath = `${assetPath}.sha256`;
  writeFileSync(sidecarPath, `${hash}  ${assetName}\n`);

  return { assetName, assetPath, sidecarPath, hash, bytes: buf.length };
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const sha = (process.argv[2] || execFileSync("git", ["rev-parse", "HEAD"]).toString().trim());
  const outDir = resolve(process.argv[3] || "rolling-dist");
  const r = buildRollingSource(sha, outDir, { requireDesktopDist: process.argv.includes("--require-desktop-dist") });
  console.log(`[rolling-source] ${r.assetName} — ${(r.bytes / 1048576).toFixed(1)} MB, sha256=${r.hash}`);
  console.log(`[rolling-source] asset:   ${r.assetPath}`);
  console.log(`[rolling-source] sidecar: ${r.sidecarPath}`);
  const subject = execFileSync("git", ["log", "-1", "--format=%s", sha]).toString().trim();
  const p = buildRollingPointer(sha, subject, outDir);
  console.log(`[rolling-source] pointer: ${p.pointerPath} → ${p.pointer.commit.slice(0, 7)}`);
}
