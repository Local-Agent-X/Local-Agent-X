#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`[mac-update-package] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) fail(`${command} failed with status ${result.status ?? "unknown"}`);
}

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) fail(`Missing required ${prefix}<value> argument`);
  return resolve(value);
}

if (process.platform !== "darwin") fail("This packaging step requires macOS.");

const appPath = argument("app");
const zipPath = argument("zip");
const blockmapPath = argument("blockmap");
const metadataPath = argument("metadata");
const appBuilderPath = argument("app-builder");
const version = process.argv.slice(2).find((entry) => entry.startsWith("--version="))?.slice(10);

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  fail("Missing or invalid --version=<semver> argument");
}
for (const path of [appPath, appBuilderPath]) {
  if (!existsSync(path)) fail(`Required input does not exist: ${path}`);
}

// electron-builder can build its DMG and ZIP targets concurrently. The app is
// still being signed/notarized while the ZIP target starts reading it, which
// can archive an internally inconsistent bundle. Re-create the update ZIP only
// after the finalized app passes signature verification.
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
rmSync(zipPath, { force: true });
rmSync(blockmapPath, { force: true });
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
run(appBuilderPath, ["blockmap", `--input=${zipPath}`, `--output=${blockmapPath}`]);

// Verify what users actually receive, not the mutable build directory.
const verifyRoot = mkdtempSync(join(tmpdir(), "lax-mac-update-verify-"));
try {
  run("ditto", ["-x", "-k", zipPath, verifyRoot]);
  const extractedApp = join(verifyRoot, basename(appPath));
  if (!existsSync(extractedApp)) fail(`Repacked ZIP does not contain ${basename(appPath)}`);
  run("xattr", ["-dr", "com.apple.provenance", extractedApp]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", extractedApp]);
} finally {
  rmSync(verifyRoot, { recursive: true, force: true });
}

const bytes = readFileSync(zipPath);
const sha512 = createHash("sha512").update(bytes).digest("base64");
const size = statSync(zipPath).size;
const fileName = basename(zipPath);
const releaseDate = new Date().toISOString();
writeFileSync(metadataPath, [
  `version: ${version}`,
  "files:",
  `  - url: ${fileName}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${fileName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  "",
].join("\n"));

console.log(`[mac-update-package] verified finalized ZIP: ${zipPath}`);
