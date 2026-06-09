import { existsSync, readdirSync } from "node:fs";
import { dirname, basename } from "node:path";

// ── Edit-failure recovery helpers ────────────────────────────────────────
// When edit() fails, the model previously saw a bare string like
// "old_string found 2 times" with no info about WHERE the matches were —
// so it would re-emit the same insufficient old_string on the next turn,
// hit the same error, and loop. Grok-code-fast-1 did this twice in a row
// on one user session, burning a 178s turn for zero edits.
// These helpers surface line numbers + surrounding context (ambiguous),
// nearest-line candidates (not-found), or sibling files (file-not-found)
// so the model's next call can disambiguate without another wasted turn.
// Output flows through err()'s metadata.recovery → rendered as a
// "Recovery: ..." line in the tool_result the canonical loop feeds back.

export function locateOccurrences(content: string, needle: string, max = 5): { line: number; snippet: string }[] {
  const matches: { line: number; snippet: string }[] = [];
  const lines = content.split("\n");
  let pos = 0;
  while (matches.length < max) {
    const idx = content.indexOf(needle, pos);
    if (idx === -1) break;
    let lineNum = 1;
    for (let i = 0; i < idx; i++) if (content[i] === "\n") lineNum++;
    const from = Math.max(0, lineNum - 2);
    const to = Math.min(lines.length, lineNum + 1);
    const snippet = lines.slice(from, to).map((l, i) => `  L${from + i + 1}: ${l}`).join("\n");
    matches.push({ line: lineNum, snippet });
    pos = idx + needle.length;
  }
  return matches;
}

export function suggestNearbyLines(content: string, oldStr: string, max = 5): { line: number; text: string }[] {
  // Use the first non-trivial line of the old_string as a probe. The model
  // probably got the surrounding context wrong but the anchor line right;
  // surfacing every line that contains the anchor lets it re-pick.
  const firstLine = (oldStr.split("\n").find((l) => l.trim().length >= 4) || "").trim();
  if (!firstLine) return [];
  const probe = firstLine.slice(0, Math.min(60, firstLine.length));
  const lines = content.split("\n");
  const hits: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    if (lines[i].includes(probe)) hits.push({ line: i + 1, text: lines[i] });
  }
  return hits;
}

export function suggestSiblingPaths(missingPath: string, max = 5): string[] {
  // Model often gets the dir right and the filename wrong (or vice versa).
  // List parent-dir entries with similar name; cheap, no recursion.
  try {
    const dir = dirname(missingPath);
    const name = basename(missingPath).toLowerCase();
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir);
    const scored = entries
      .map((e) => ({ e, score: similarity(e.toLowerCase(), name) }))
      .filter((s) => s.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, max);
    return scored.map((s) => `${dir}/${s.e}`.replace(/\\/g, "/"));
  } catch {
    return [];
  }
}

// Lightweight similarity: longest common substring ratio. Good enough for
// "did the model mean foo.tsx when it said foo.ts" without a Levenshtein dep.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  if (long.length === 0) return 0;
  let longest = 0;
  for (let i = 0; i < short.length; i++) {
    for (let j = i + 1; j <= short.length; j++) {
      if (long.includes(short.slice(i, j))) longest = Math.max(longest, j - i);
      else break;
    }
  }
  return longest / long.length;
}

function leadingWhitespace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? "";
}

// Tier-3 edit fallback. The model reproduced a block's content and RELATIVE
// indentation but guessed the absolute indent wrong — every line shifted by the
// same leading-whitespace prefix. Models other than Claude do this constantly
// (Grok edit loop, 2026-06-09: 5 failed edits → circuit-breaker open, zero
// edits landed, purely because old_string's indent didn't byte-match). The two
// existing tiers (exact, then CRLF) don't cover it. Here: match lines by their
// TRIMMED content; require the block to be UNIQUE; rebase new_string from the
// model's indent frame onto the file's real one so relative structure is kept;
// splice by byte offset so CRLF and the rest of the file are untouched. Bail
// (caller falls through to the exact-match error) on no match, >1 match, or a
// new_string line that isn't in the model's indent frame — a wrong-indent write
// is worse than a failed edit, so never guess when the mapping is unclear.
export function whitespaceTolerantEdit(
  content: string,
  oldStr: string,
  newStr: string,
): { kind: "ok"; updated: string } | { kind: "none" } | { kind: "ambiguous" } {
  const fileLines = content.split("\n");
  const oldLines = oldStr.split("\n");
  const oldTrim = oldLines.map((l) => l.trim());

  let start = -1;
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let hit = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j].trim() !== oldTrim[j]) { hit = false; break; }
    }
    if (!hit) continue;
    if (start !== -1) return { kind: "ambiguous" };
    start = i;
  }
  if (start === -1) return { kind: "none" };

  const matched = fileLines.slice(start, start + oldLines.length);
  const anchor = oldTrim.findIndex((t) => t.length > 0);
  if (anchor === -1) return { kind: "none" }; // whitespace-only block, too risky
  const fileWs = leadingWhitespace(matched[anchor]);
  const oldWs = leadingWhitespace(oldLines[anchor]);

  const newLines = newStr.split("\n").map((line) => {
    if (line.trim() === "") return "";
    const ws = leadingWhitespace(line);
    if (!ws.startsWith(oldWs)) return null; // not in the model's indent frame
    return fileWs + line.slice(oldWs.length);
  });
  if (newLines.some((l) => l === null)) return { kind: "none" };

  const eol = matched.some((l) => l.endsWith("\r")) ? "\r\n" : "\n";
  const offsetStart = fileLines.slice(0, start).reduce((n, l) => n + l.length + 1, 0);
  const windowLen = matched.join("\n").length;
  const updated =
    content.slice(0, offsetStart) +
    (newLines as string[]).join(eol) +
    content.slice(offsetStart + windowLen);
  return { kind: "ok", updated };
}
