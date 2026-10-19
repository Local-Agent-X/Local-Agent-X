#!/usr/bin/env node
/**
 * commit-msg hook: a commit subject names what changed and why, never the
 * size rule. "split X (under the 400-LOC gate)" tells the next reader of
 * `git log` nothing about the code; the job that moved ("the retry policy
 * gets its own module") is what they need. The same rule is prose in AGENTS.md
 * and in the structure kit's AGENTS.md for built projects, which get no hooks.
 *
 * Usage (from the hook): node scripts/check-commit-subject.mjs <message-file>
 * Bypass: SKIP_COMMIT_SUBJECT_CHECK=1 git commit ...
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Each pattern is a way a subject cites the size rule rather than the change.
const SIZE_RULE = [
  /\bLOC\b/, // the rule's unit; uppercase only, so "loc strings" is free
  /\b\d{3}[- ]?(?:code[- ])?lines?[- ](?:cap|limit|ceiling|gate|rule|budget)\b/i,
  /\b(?:line|size|LOC)[- ](?:cap|limit|ceiling|gate)\b/i,
  /\b(?:code|file|function)[- ]size[- ](?:cap|gate|limit|ceiling|rule|check)\b/i,
  /\b(?:split|trim|shrink|shorten|cut|carve)\b.{0,60}\b(?:under|below|within|to fit)\s+(?:the\s+)?(?:\d{3}[- ]?(?:code[- ])?(?:lines?|LOC)|cap|limit|ceiling)\b/i,
];

/** The commit's subject: the first line that is not blank and not a `#` comment. */
export function commitSubject(message) {
  return message.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
}

export function citesSizeRule(subject) {
  return SIZE_RULE.some((re) => re.test(subject));
}

function main() {
  if (process.env.SKIP_COMMIT_SUBJECT_CHECK) return;
  const subject = commitSubject(readFileSync(process.argv[2], "utf-8"));
  if (!citesSizeRule(subject)) return;
  console.error(`commit-msg: the subject cites the size rule: "${subject}"`);
  console.error("  Name the commit after what changed and why: the job that moved and the module it moved to,");
  console.error("  not the limit it was moved for. Bypass: SKIP_COMMIT_SUBJECT_CHECK=1 git commit ...");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
