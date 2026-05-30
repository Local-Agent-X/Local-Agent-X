/**
 * Detective tripwire for the self_edit sandbox path.
 *
 * The env scrub (child-env.ts) closes the trivial bulk-credential exfil
 * path. This catches a different vector: a prompt-injected child STAGING a
 * secret into the source tree — writing a credential it scraped into a .ts
 * file so it rides out on the eventual commit/push, or otherwise baking
 * secret-shaped material into the diff it produces.
 *
 * It scans only ADDED content (tracked-file additions + brand-new files) in
 * the worktree against the canonical secret-shape catalog
 * (security/secret-scanner.ts). A hit HOLDs the merge for human review —
 * the same posture as the security diff-scope gate; the branch is preserved
 * so a human can `git diff` it.
 *
 * What it does NOT catch: live network egress from the child's bash (the
 * irreducible residual — see docs/self-edit-hardening.md, M3). This is a
 * staging/output tripwire, not an egress jail.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanForSecrets } from "../security/secret-scanner.js";

/** Per-file scan budget — skip pathological large additions (e.g. a vendored
 *  blob or generated lockfile) rather than choke the gate. */
const MAX_FILE_SCAN_BYTES = 512 * 1024;

export interface ExfilHit {
  file: string;
  /** Distinct secret-pattern names matched in this file's added content. */
  patterns: string[];
}

export interface ExfilScanResult {
  clean: boolean;
  hits: ExfilHit[];
}

/** One file's added content, ready to scan. */
export interface AddedContent {
  file: string;
  text: string;
}

/**
 * Pure core: scan a set of (file, added-text) pairs for secret-shaped
 * material. Separated from the git extraction so it's unit-testable without
 * a real worktree.
 */
export function findSecretsInAddedContent(items: AddedContent[]): ExfilScanResult {
  const hits: ExfilHit[] = [];
  for (const { file, text } of items) {
    if (!text) continue;
    const result = scanForSecrets(text);
    if (!result.clean) {
      const patterns = [...new Set(result.matches.map(m => m.pattern))];
      hits.push({ file, patterns });
    }
  }
  return { clean: hits.length === 0, hits };
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      windowsHide: true,
      env: process.env,
    }).toString();
  } catch {
    return "";
  }
}

/**
 * Parse a unified `git diff` into per-file added-line text. Added lines
 * start with a single "+" (the "+++ b/path" header is excluded). Returns a
 * map of path → concatenated added lines.
 */
function parseAddedLines(diff: string): Map<string, string> {
  const byFile = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      // "+++ b/src/foo.ts" → "src/foo.ts"; "+++ /dev/null" on deletes.
      const path = line.slice(4).replace(/^b\//, "").trim();
      current = path === "/dev/null" ? null : path;
      if (current && !byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      byFile.get(current)!.push(line.slice(1));
    }
  }
  const out = new Map<string, string>();
  for (const [file, lines] of byFile) out.set(file, lines.join("\n"));
  return out;
}

/**
 * Collect added content from a worktree: additions to tracked files (vs
 * HEAD) plus the full content of new untracked files.
 */
export function collectAddedContent(worktreePath: string): AddedContent[] {
  const items: AddedContent[] = [];

  // Tracked modifications — added (+) lines from the diff against HEAD.
  const diff = git(worktreePath, ["diff", "--no-color", "HEAD"]);
  if (diff) {
    for (const [file, text] of parseAddedLines(diff)) {
      if (text) items.push({ file, text });
    }
  }

  // Untracked new files — full content (capped).
  const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  for (const rel of untracked) {
    const abs = join(worktreePath, rel);
    try {
      if (statSync(abs).size > MAX_FILE_SCAN_BYTES) continue;
      items.push({ file: rel, text: readFileSync(abs, "utf-8") });
    } catch {
      /* unreadable / vanished — skip */
    }
  }

  return items;
}

/** Scan everything the subprocess added to the worktree for staged secrets. */
export function scanWorktreeForStagedSecrets(worktreePath: string): ExfilScanResult {
  return findSecretsInAddedContent(collectAddedContent(worktreePath));
}
