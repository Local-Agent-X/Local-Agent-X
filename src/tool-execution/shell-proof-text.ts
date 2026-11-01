/**
 * The command text the disposable-delete proofs read (disposable-tree-delete.ts,
 * and the card's words in approval-card-text.ts), with two spellings resolved
 * that the proofs could not place, and so carded:
 *
 *  - `$NAME` and `${NAME}` after `NAME=<literal>` earlier on the same line.
 *    The 2026-10-31 card: `W="…/apps"; mkdir -p "$W/x" && cd "$W/x" && … rm
 *    -rf package`, every target a fresh file in a folder the command makes,
 *    kept its card because `$W` could be anything. Only a literal counts:
 *    one word with no expansion in it, assigned once, outside every compound
 *    command. A use before the assignment is the environment's value and
 *    stays `$NAME`. Inside single quotes nothing expands, so nothing is
 *    replaced there; unquoted, a value with whitespace would split into
 *    words, so it stays `$NAME` there too.
 *  - On Windows, when the command will run in Git Bash, its `/c/…` drive
 *    paths and `/tmp` as the Win32 paths they are there. The proofs refuse
 *    `/x/…` as a path they cannot place (Git Bash's mount, a share, or a real
 *    folder under PowerShell); under Git Bash it is one path, `C:\…`.
 *
 * Fail-closed: what is not resolved is left as written and the proofs refuse
 * it as before. Never used for detection (isDestructiveCommand reads the raw
 * text, first): resolving a word can make a proof placeable, never hide a
 * pattern.
 */
import { tmpdir } from "node:os";
import { shellSegments } from "../security/layer/shell-lex.js";
import { resolveWindowsShell } from "../tools/shell-env.js";
import { segmentDepths } from "./delete-prefix.js";

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/s;
const BARE_WORD = /^[^\s"'`$*?~%&|;<>()\\{}[\]]+$/;
const USE = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/;

/** The literal a `NAME=value` assigns, or null when the value is not one word
 *  spelled out in full. */
function literalOf(value: string): string | null {
  const v = value.trim();
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).includes("'") ? null : v.slice(1, -1);
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    const body = v.slice(1, -1);
    return /[$`"\\]/.test(body) ? null : body;
  }
  return BARE_WORD.test(v) ? v : null;
}

/** Each name assigned exactly one literal at the top level, with the segment
 *  that assigns it. A name assigned twice, or inside a compound, is left out. */
function literalAssignments(segments: ReturnType<typeof shellSegments>, depths: number[]): Map<string, { value: string; at: number }> {
  const out = new Map<string, { value: string; at: number }>();
  const unusable = new Set<string>();
  segments.forEach((s, i) => {
    const m = ASSIGNMENT.exec(s.text.trim());
    if (!m) return;
    const literal = literalOf(m[2]);
    if (literal === null || depths[i] > 0 || out.has(m[1]) || unusable.has(m[1])) { unusable.add(m[1]); out.delete(m[1]); return; }
    out.set(m[1], { value: literal, at: i });
  });
  return out;
}

/** `text` with each use of a known name replaced, outside single quotes. */
function substitute(text: string, at: number, vars: Map<string, { value: string; at: number }>): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") { out += text.slice(i, i + 2); i++; continue; }
    if (quote === null && (c === "'" || c === '"')) quote = c;
    else if (c === quote) quote = null;
    if (c !== "$" || quote === "'") { out += c; continue; }
    const m = USE.exec(text.slice(i));
    const v = m && vars.get(m[1] ?? m[2]);
    if (!m || !v || v.at >= at || (quote === null && /\s/.test(v.value))) { out += c; continue; }
    out += v.value;
    i += m[0].length - 1;
  }
  return out;
}

/** Git Bash's spellings, at a word's start: `/c/…` is `C:/…`, `/tmp` is the
 *  user's TEMP folder (Git for Windows' fstab mounts it there). */
function fromGitBash(text: string): string {
  const temp = tmpdir().replace(/\\/g, "/");
  return text
    .replace(/(^|[\s"'=])\/([a-zA-Z])(?=\/)/g, (_m, lead: string, drive: string) => `${lead}${drive.toUpperCase()}:`)
    .replace(/(^|[\s"'=])\/tmp(?=\/|$|[\s"'])/g, (_m, lead: string) => `${lead}${temp}`);
}

function runsInGitBash(): boolean {
  return process.platform === "win32" && resolveWindowsShell().kind === "bash";
}

/** `command` as the proofs read it. `gitBash` is whether a Windows run is in
 *  Git Bash; left out, it is what the bash tool would use. */
export function proofText(command: string, gitBash: boolean = runsInGitBash()): string {
  const segments = shellSegments(command);
  const vars = literalAssignments(segments, segmentDepths(command));
  const text = vars.size === 0 ? command
    : segments.map((s, i) => `${i === 0 ? "" : s.after ?? ""}${substitute(s.text, i, vars)}`).join("");
  return gitBash ? fromGitBash(text) : text;
}
