/**
 * Which word of a grep/rg command is its search PATTERN, so the shell path
 * guard does not check a pattern as a file. `grep -c "/src/" a.ts` was refused
 * in workspace mode because `/src/` read as a folder at the root of the drive
 * (LAX vs Claude Code run, 2026-11-13).
 *
 * The pattern is the first operand only when no flag supplies the pattern
 * (`-e PAT`, `-f FILE`, `--regexp`, `--file`); then there is none, and every
 * operand stays checked — `-f` names a real file to read. A short-flag cluster
 * holding `e` or `f` (`-rf pats.txt`) counts as supplying one. A value-taking
 * flag this list does not know only shifts the guess onto its value, and the
 * real pattern is then checked as a path: a false refusal, never a missed file.
 */

const SEARCH_VERBS = new Set(["grep", "egrep", "fgrep", "rg"]);
/** Short flags whose value is the next word (grep and rg). */
const SHORT_WITH_VALUE = new Set(["A", "B", "C", "m", "d", "D", "g", "t", "T", "j", "M", "E"]);
/** Long flags whose value is the next word when written without `=`. */
const LONG_WITH_VALUE = new Set([
  "--after-context", "--before-context", "--context", "--max-count", "--directories", "--devices",
  "--label", "--include", "--exclude", "--exclude-dir", "--binary-files", "--glob", "--iglob",
  "--type", "--type-not", "--threads", "--max-columns", "--encoding", "--max-depth",
]);

/** Index in `words` of the pattern operand of the search command whose verb is
 *  at `at`, or -1 when it is not a search command or a flag supplies the pattern. */
export function searchPatternOperand(words: readonly string[], at: number, verb: string): number {
  if (!SEARCH_VERBS.has(verb)) return -1;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    // Quotes are gone by now, so a redirect (`>out`) and a quoted pattern
    // (`"<a>"`) look alike. Guessing past either could leave the next operand,
    // a real file, unchecked; so skip nothing once one appears.
    if (/[<>]/.test(w)) return -1;
    if (w === "--") return i + 1 < words.length ? i + 1 : -1;
    if (/^--(?:regexp|file)(?:=|$)/.test(w)) return -1;
    if (w.startsWith("--")) { if (LONG_WITH_VALUE.has(w)) i++; continue; }
    if (/^-[A-Za-z]/.test(w)) {
      const letters = w.slice(1);
      if (/[ef]/.test(letters)) return -1;
      if (SHORT_WITH_VALUE.has(letters[letters.length - 1]) && letters.length === 1) i++;
      continue;
    }
    return i;
  }
  return -1;
}
