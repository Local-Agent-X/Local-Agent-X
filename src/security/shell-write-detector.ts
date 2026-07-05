/**
 * "Does this shell command WRITE to the filesystem?" — the detector that closes
 * the instruction-ledger shell escape. bash/process_start are SHELL-class, so a
 * `workspace-write` prohibition ("don't edit any files") otherwise wouldn't stop
 * a model from mutating files via `sed -i`, `cat > f`, a heredoc, `cp`, `rm`,
 * etc. pre-dispatch calls this to block a mutating shell command under such a
 * ban, while leaving read-only shell (grep/ls/cat) alone.
 *
 * Split out of shell-detectors.ts (which sits at the 400-LOC hygiene ceiling);
 * reuses that module's inline-script + quote-stripping primitives.
 */
import { detectScriptWrite, stripQuotedSpans } from "./shell-detectors.js";

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
 * NOT airtight: an arbitrary interpreter one-liner that writes via an
 * unrecognized call can slip past static analysis — a documented limit,
 * backstopped by the post-hoc mutation gates. Reuses detectScriptWrite for the
 * inline-script and in-place-edit cases. Quoted spans are stripped first so a
 * literal `>` inside a string argument isn't mistaken for a redirect.
 */
export function shellCommandWritesFiles(command: string): boolean {
  if (detectScriptWrite(command)) return true;
  const stripped = stripQuotedSpans(command);
  const redir = stripped.match(/(?:^|\s)\d*>>?\s*([^\s|;&()<>]+)/);
  if (redir && !BENIGN_REDIRECT_TARGET.test(redir[1])) return true;
  return MUTATING_CMD_AT_POS.test(stripped);
}
