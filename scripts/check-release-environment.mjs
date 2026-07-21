#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function missingReleasePrerequisites() {
  const missing = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) missing.push("Node.js 22 or newer");
  const git = spawnSync("git", ["--version"], { windowsHide: true });
  if (git.status !== 0) missing.push("git executable");
  return missing;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const missing = missingReleasePrerequisites();
  if (missing.length) {
    console.error(`release environment prerequisites missing: ${missing.join(", ")}`);
    process.exit(2);
  }
  console.log("check-release-environment: OK");
}
