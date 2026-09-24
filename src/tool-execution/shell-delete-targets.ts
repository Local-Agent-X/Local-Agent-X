/**
 * The files a shell command would delete one by one.
 *
 * EXP-18 (2026-09-24) found the gap: with `delete_file` out of the schema the
 * model fell from `rm -rf` (carded by the irreversible floor) to five
 * single-file `rm` commands, which no floor and no gate covered, and the
 * originals were gone. The un-named-delete rule ("a delete is pre-authorized
 * only when the USER named the file") applied to one tool; a shell delete of
 * the same file is the same act. This module lists the targets so
 * unnamed-delete-gate.ts can apply the one rule to both.
 *
 * Scope is the NON-recursive forms only. `rm -r`, `Remove-Item -Recurse`,
 * `find -delete` and the rest already hit the irreversible floor in
 * approval-decision.ts and get their card there; carding them here too would
 * be a second card for one decision. `git rm` is excluded, as it is on the
 * floor: git is its undo.
 */

/** Command segments: `a && b`, `a; b`, `a || b`, `a | b`, one per line. */
function segments(command: string): string[] {
  return command.split(/\r?\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

/** A small, quote-aware tokenizer for argv-shaped text. Single quotes, double
 *  quotes and backslash escapes outside quotes; unterminated quotes run to the
 *  end. Deliberately not a shell: it exists to read paths, not to execute. */
export function shellWords(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Inside double quotes a backslash escapes only $ ` " \ and newline; any
      // other backslash is literal — `del "client-data\tmp\x.tmp"` names that
      // path, not "client-datatmpx.tmp". Found live on the EXP-18 retry.
      if (ch === "\\" && quote === '"' && i + 1 < segment.length && /[$`"\\\n]/.test(segment[i + 1])) { cur += segment[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < segment.length) { cur += segment[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ""; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const RM_RECURSIVE = /^-[^-]*[rR]|^--recursive$/;
const REMOVE_ITEM_RECURSE = /^-recurse$/i;
/** PowerShell switch parameters: no value follows. Anything else that starts
 *  with `-` consumes the next word. */
const PS_SWITCHES = /^-(force|recurse|whatif|confirm|verbose|debug|passthru|f|r)$/i;

function stripEnvAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^\w+=/.test(words[i])) i++;
  return words.slice(i);
}

function basenameOf(word: string): string {
  return (word.split("/").pop() ?? word).split("\\").pop() ?? word;
}

/** Targets of one segment, or [] when it is not a single-file delete. */
function segmentTargets(segment: string): string[] {
  const words = stripEnvAssignments(shellWords(segment));
  if (words.length === 0) return [];
  // `sudo rm …`, `command rm …`, `powershell -Command "Remove-Item …"`: look
  // through one wrapper.
  const head = basenameOf(words[0]).toLowerCase();
  if (head === "sudo" || head === "command" || head === "env") return segmentTargets(words.slice(1).join(" "));
  if ((head === "powershell" || head === "pwsh") && words.length >= 2) {
    const idx = words.findIndex((w, i) => i > 0 && /^-c(ommand)?$/i.test(w));
    const inner = idx >= 0 ? words.slice(idx + 1).join(" ") : words.slice(1).join(" ");
    return segments(inner).flatMap(segmentTargets);
  }
  if (head === "rm" || head === "unlink") {
    const rest = words.slice(1);
    const paths: string[] = [];
    let endOfFlags = false;
    for (const w of rest) {
      if (!endOfFlags && w === "--") { endOfFlags = true; continue; }
      if (!endOfFlags && w.startsWith("-") && w.length > 1) {
        if (RM_RECURSIVE.test(w)) return [];                         // the floor's case
        continue;
      }
      paths.push(w);
    }
    return paths;
  }
  if (head === "remove-item" || head === "ri" || head === "del" || head === "erase") {
    const rest = words.slice(1);
    if (rest.some((w) => REMOVE_ITEM_RECURSE.test(w))) return [];
    const paths: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      if (/^-(path|literalpath)$/i.test(w)) { if (rest[i + 1]) paths.push(...rest[++i].split(",").map((p) => p.trim()).filter(Boolean)); continue; }
      if (/^-/.test(w)) {
        // A PowerShell parameter. Switches (-Force, -WhatIf, -Confirm, …) stand
        // alone; every other parameter takes the NEXT word as its value
        // (`-ErrorAction Stop`, `-Filter *.tmp`, `-Exclude keep.md`), and that
        // value is not a path the user must have named. `-Confirm:$false` is
        // one word. Found live: `-ErrorAction Stop` read as a file called
        // "Stop", so a named delete drew the un-named card (2026-09-24).
        if (!PS_SWITCHES.test(w) && rest[i + 1] !== undefined && !/^-/.test(rest[i + 1])) i++;
        continue;
      }
      if (/^\//.test(w) && head === "del") continue;                    // del's /F /Q
      paths.push(...w.split(",").map((p) => p.trim()).filter(Boolean));
    }
    return paths;
  }
  return [];
}

/** Every file a command deletes one at a time, in order, deduplicated. Globs
 *  are kept as written: a pattern names no file, so the gate treats it as
 *  un-named — the same rule as a pattern in `delete_file`. */
export function shellDeleteTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of segments(command)) {
    for (const p of segmentTargets(seg)) if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
