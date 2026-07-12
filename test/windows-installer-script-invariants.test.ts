import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Windows PowerShell 5.1 — the stock interpreter on every Windows box — reads
// BOM-less .ps1 files as ANSI (CP1252). A UTF-8 em-dash/ellipsis inside a
// double-quoted string then decodes to a curly quote, which 5.1 treats as a
// string terminator: install.ps1 failed to parse AT ALL for fresh installs
// (regression 122f4e3c; python/sovits/install.ps1 had the same latent break).
// Invariant: any tracked .ps1 containing non-ASCII bytes must carry a UTF-8 BOM.
//
// Second invariant: cmd parses `::` comments inside a parenthesized block as a
// drive-relative path and prints "The system cannot find the drive specified."
// mid-install — tracked .bat files must not have indented `::` comments.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function tracked(pattern: string): string[] {
  return execFileSync("git", ["ls-files", pattern], { cwd: repoRoot, encoding: "utf-8" })
    .split("\n").map(s => s.trim()).filter(Boolean);
}

describe("windows installer script invariants", () => {
  it("every tracked .ps1 with non-ASCII content starts with a UTF-8 BOM", () => {
    const offenders: string[] = [];
    for (const file of tracked("*.ps1")) {
      const bytes = readFileSync(join(repoRoot, file));
      const hasNonAscii = bytes.some(b => b > 127);
      const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      if (hasNonAscii && !hasBom) offenders.push(file);
    }
    expect(offenders, `PS 5.1 mis-decodes these as ANSI — add a UTF-8 BOM (or strip non-ASCII): ${offenders.join(", ")}`).toEqual([]);
  });

  it("no tracked .bat uses :: comments inside a parenthesized block", () => {
    const offenders: string[] = [];
    for (const file of tracked("*.bat")) {
      const lines = readFileSync(join(repoRoot, file), "utf-8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s+::/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders, `indented :: comments break inside ( ) blocks — use rem or move above the block: ${offenders.join(", ")}`).toEqual([]);
  });
});
