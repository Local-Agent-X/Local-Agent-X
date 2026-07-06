/**
 * "Does this shell command WRITE to the filesystem?" — the detector that closes
 * the instruction-ledger shell escape. bash/process_start are SHELL-class, so a
 * `workspace-write` prohibition ("don't edit any files") otherwise wouldn't stop
 * a model from mutating files via `sed -i`, `cat > f`, a heredoc, `cp`, `rm`,
 * etc. pre-dispatch calls this to block a mutating shell command under such a
 * ban, while leaving read-only shell (grep/ls/cat) alone.
 *
 * Split out of shell-detectors.ts (which sits at the 400-LOC hygiene ceiling);
 * reuses that module's inline-script, eval-form-refusal, and quote/token
 * primitives.
 */
import {
  detectInlineInterpreterEval,
  detectScriptWrite,
  stripQuotedSpans,
  tokenizeCommand,
} from "./shell-detectors.js";

// A redirect target that is a benign device / fd dup, not a real file.
const BENIGN_REDIRECT_TARGET = /^\/dev\/(?:null|stdout|stderr|tty|zero|fd\/\d+)$/i;

// Mutating binaries at a COMMAND POSITION (start, or after a separator/pipe,
// past an optional sudo/command/env prefix). Command-position anchored so these
// words appearing as ARGUMENTS ("grep -rn touch .") never false-positive.
const MUTATING_CMD_AT_POS =
  /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+|command\s+|env\s+(?:\w+=\S*\s+)+)*(?:cp|mv|rm|rmdir|install|dd|truncate|touch|mkdir|chmod|chown|ln|rsync|tee|patch|shred|unlink)\b/i;

/**
 * Best-effort: does this shell command WRITE to the filesystem (create, modify,
 * or delete a file)? Read-only shell (grep/ls/cat/find) returns false; `git
 * commit` (no workspace write) and redirects to `/dev/null` return false.
 *
 * Interpreter one-liners are NOT pattern-matched for write calls — the FORM is
 * refused wholesale (see below), so `os.remove` / `fs.rmSync` / an indirected
 * open() mode can't slip past an idiom allowlist. Reuses detectScriptWrite for
 * the heredoc and in-place-edit cases. Quoted spans are stripped before the
 * redirect/command-position arms so a literal `>` inside a string argument
 * isn't mistaken for a redirect.
 */
export function shellCommandWritesFiles(command: string): boolean {
  if (detectScriptWrite(command)) return true;
  // An inline-eval interpreter body (`python -c`, `node -e`, `perl -e`, …) is
  // Turing-complete: detectScriptWrite's write-idiom allowlist can never
  // enumerate every mutating call (`os.remove('x')`, `fs.rmSync`,
  // `open(f,'r+')`, `m='w'; open(p,m)`…). Under a write ban the body is
  // un-analyzable, so the FORM counts as write-capable wholesale — reuse
  // detectInlineInterpreterEval (per pipe segment, like shell-policy) with a
  // hard "refuse" policy: the ban implies refusal even when the global
  // inline-eval policy is permissive, so a permissive default can't reopen
  // this escape. Intentional over-block: `python -c "print(1)"` is refused
  // under a ban — it can't be verified read-only; the agent should use a read
  // tool or a script file the path guard can see. process.cwd() is the
  // best-effort workspace anchor for the rename-escape arm (this gate has no
  // per-op workspace); the known-interpreter arm doesn't use it at all.
  for (const segment of command.split("|")) {
    if (detectInlineInterpreterEval(tokenizeCommand(segment), "refuse", process.cwd())) {
      return true;
    }
  }
  const stripped = stripQuotedSpans(command);
  const redir = stripped.match(/(?:^|\s)\d*>>?\s*([^\s|;&()<>]+)/);
  if (redir && !BENIGN_REDIRECT_TARGET.test(redir[1])) return true;
  return MUTATING_CMD_AT_POS.test(stripped);
}
