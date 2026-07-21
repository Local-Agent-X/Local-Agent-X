#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

const explicitBase = process.env.LAX_RELEASE_BASE_REF?.trim();
let range = "HEAD";
if (explicitBase) {
  git(["rev-parse", "--verify", explicitBase]);
  range = `${explicitBase}..HEAD`;
} else {
  const previous = spawnSync("git", ["describe", "--tags", "--abbrev=0", "HEAD^"], { encoding: "utf8", windowsHide: true });
  if (previous.status === 0 && previous.stdout.trim()) range = `${previous.stdout.trim()}..HEAD`;
}

const records = git(["log", "--format=%H%x00%B%x00", range]).split("\0").filter(Boolean);
const failures = [];
for (let index = 0; index < records.length; index += 2) {
  const commit = records[index];
  const message = records[index + 1] ?? "";
  const attributionLines = message.split(/\r?\n/).filter((line) => /^(?:assisted-by|co-authored-by):/i.test(line));
  const codexLines = attributionLines.filter((line) => /codex/i.test(line));
  if (codexLines.some((line) => line !== "Assisted-by: Codex") || codexLines.length > 1) {
    failures.push(`${commit}: Codex attribution must be exactly one 'Assisted-by: Codex' trailer`);
  }
}

if (failures.length) {
  console.error(`check-release-attribution: FAIL (${range})`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log(`check-release-attribution: OK (${Math.floor(records.length / 2)} commits, ${range})`);
