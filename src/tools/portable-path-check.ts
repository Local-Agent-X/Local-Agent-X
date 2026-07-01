// Write-time portability guard. A concrete user-home absolute path baked into
// portable source is the "works on my machine" bug: on any other machine it
// resolves to nothing (a silent no-op — the file/dir just isn't there) or the
// wrong location. The motivating failure was a generated guard script that
// hardcoded `ROOT = "/Users/dad/…"` instead of `process.cwd()` — it walked
// nothing on every other machine yet printed a green "0/0 passed", protecting
// nothing forever. That's WORSE than a crash: false assurance with no signal.
//
// This is a NON-FATAL note, not a hard reject. An absolute home path is a
// CONTEXTUAL smell, not an unambiguous error (a script may legitimately target
// the real home dir), so the write lands and the model is told to rebuild the
// path from a portable base if it wasn't intentional. Hard-rejecting here would
// brick a legitimate write — the opposite failure class. Contrast checkEditSyntax
// (syntax-validate.ts), which DOES hard-reject: a broken parse is machine-
// independent and unambiguous; a home path is neither.

import { homedir } from "node:os";

// Portable source / scripts only. Docs (.md/.txt/.rst) are excluded on purpose:
// an absolute path in a README is usually a real, intended example for THIS
// user. Config formats with commonly-intentional absolute paths (yaml/toml/ini —
// volume mounts, mount points) are also left out; json stays because a home path
// committed into a json config is the same works-on-my-machine leak.
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|json)$/i;

// A concrete user-home path. The leading lookbehind requires a non-identifier
// char before the path so a URL segment (`https://host/home/dashboard`) or a
// relative path (`src/home/x`) doesn't trip it — only a real path boundary
// (start, whitespace, quote, `=`, `(`, `/`) counts. `(Users|home)` is
// case-SENSITIVE: macOS is always `/Users`, Linux always `/home`; a lowercase
// `/users/` or a `/Home/` is not a real home root and is skipped (kills more URL
// false positives). Capture group 1 is the username segment (for the placeholder
// filter); the whole match (m[0]) is the FULL path — trailing sub-segments are
// consumed so two distinct paths under one home stay distinct (delta-awareness).
const UNIX_HOME_RE = /(?<![A-Za-z0-9._-])\/(?:Users|home)\/([A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*/g;
// Windows: C:\Users\<name>\…, incl. the escaped C:\\Users\\ and forward-slash
// C:/Users/ forms. Lookbehind rejects a letter before the drive letter so
// `https://Users/x` (letter `s`) can't masquerade as a drive path.
const WIN_HOME_RE = /(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9._-]+)(?:[\\/]{1,2}[A-Za-z0-9._-]+)*/gi;

// Segments that read as documentation/placeholders, not a real machine leak.
const PLACEHOLDER = new Set([
  "username", "user", "user_name", "youruser", "your-user", "yourusername",
  "yourname", "your-name", "name", "me", "example", "user1", "someone",
]);

function findHomePaths(text: string): string[] {
  const found: string[] = [];
  const consider = (segment: string, full: string) => {
    if (!PLACEHOLDER.has(segment.toLowerCase())) found.push(full);
  };
  for (const m of text.matchAll(UNIX_HOME_RE)) consider(m[1], m[0]);
  for (const m of text.matchAll(WIN_HOME_RE)) consider(m[1], m[0]);
  return found;
}

/**
 * Return a portability note when a write introduces a machine-specific absolute
 * home path into portable source, or null. Delta-aware: a home path already
 * present in `before` is not this edit's fault (and nagging about it on every
 * unrelated edit would be noise), so only paths NEW to `after` are reported.
 *
 * @param before content before the edit, or null for a new file
 * @param after  content the write would land
 */
export function checkHardcodedHomePath(filePath: string, before: string | null, after: string): string | null {
  if (!SOURCE_RE.test(filePath)) return null;

  const hits = new Set(findHomePaths(after));

  // Booster: this machine's actual home dir baked in verbatim is a definite env
  // leak even when its basename looks like a placeholder (e.g. a user literally
  // named "user"). Kept separate from the regex so the regex stays machine-
  // independent and deterministic for tests.
  let home = "";
  try { home = homedir(); } catch { /* unavailable — skip the booster */ }
  if (home.length > 3 && after.includes(home)) hits.add(home);

  if (hits.size === 0) return null;

  const beforeText = before ?? "";
  const fresh = [...hits].filter((p) => !beforeText.includes(p));
  if (fresh.length === 0) return null;

  const shown = fresh.slice(0, 3).map((p) => `"${p}"`).join(", ");
  const more = fresh.length > 3 ? ` (+${fresh.length - 3} more)` : "";
  return (
    `Portability: ${filePath} now hardcodes a machine-specific home path: ${shown}${more}. ` +
    `Baked to THIS machine, it resolves to nothing (a silent no-op) or the wrong location on ` +
    `any other machine — the "works on my machine" bug. If the path wasn't meant to be absolute, ` +
    `rebuild it from a portable base: process.cwd() for the project root, os.homedir() for the ` +
    `home dir, or new URL(".", import.meta.url) / __dirname for a path relative to this file, then ` +
    `join the rest with path.join(). The file WAS written — fix it if this wasn't intentional.`
  );
}
