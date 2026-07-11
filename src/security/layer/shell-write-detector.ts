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
  splitShellSegments,
  stripQuotedSpans,
  tokenizeCommand,
} from "./shell-detectors.js";
import { execBasename } from "./shell-lex.js";
import { INTERP_EVAL_FLAGS } from "./shell-rules.js";

// A redirect target that is a benign device / fd dup, not a real file.
const BENIGN_REDIRECT_TARGET = /^\/dev\/(?:null|stdout|stderr|tty|zero|fd\/\d+)$/i;

// Mutating binaries at a COMMAND POSITION (start, or after a separator/pipe,
// past an optional sudo/command/env prefix). Command-position anchored so these
// words appearing as ARGUMENTS ("grep -rn touch .") never false-positive.
const MUTATING_CMD_AT_POS =
  /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+|command\s+|env\s+(?:\w+=\S*\s+)+)*(?:cp|mv|rm|rmdir|install|dd|truncate|touch|mkdir|chmod|chown|ln|rsync|tee|patch|shred|unlink)\b/i;

// Characters that DETACH an interpreter token from a wrapper/prefix/nesting so
// its basename stands alone: whitespace plus the shell metacharacters that open
// a new command position WITHOUT being a top-level command separator — subshell
// `(`/`)`, brace group `{`/`}`, backtick and `$` command substitution, `=` env
// assignment (`V=1 python`, `x=$(python`), and redirect angles. Command
// separators (`; & |` newline) are handled by splitShellSegments before this,
// so they're absent here. Splitting on these means `command`/`nice`/`timeout`/
// `xargs` wrappers, an env prefix, a subshell, or a `$( )`/backtick substitution
// no longer keep the interpreter buried in a non-argv0 slot.
const INTERP_DETACH_BOUNDARY = /[\s(){}`$=<>]/;

// Tokenize a single command SEGMENT for the anywhere-interpreter scan: drop
// quoted spans wholesale (a literal `python -c` inside a string argument must
// NOT match — `echo "python -c foo"`), and split on INTERP_DETACH_BOUNDARY so a
// wrapped/prefixed/substituted interpreter surfaces as its own token. Mirrors
// stripQuotedSpans' quote-state walk; best-effort like the rest of the module.
function detachTokens(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null; // drop quoted content entirely
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (INTERP_DETACH_BOUNDARY.test(c)) {
      if (cur) { tokens.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ── Anywhere-in-command inline-eval interpreter scan (write-ban form refusal) ──
// The per-segment loop below only inspects each segment's argv[0], so an
// interpreter in a NON-argv0 slot escapes the ban and is ALLOWED:
//   `command python -c …`   (the `command` builtin)
//   `nice python -c …` / `timeout 5 python -c …` / `xargs python -c …`  (wrappers)
//   `V=1 python -c …`       (env-var prefix)
//   `x=$(python -c …)` / `echo $(node -e …)` / backtick subst
//   `(python -c …)` / `{ python -c …; }`  (subshell / brace group)
// Refuse if a known interpreter basename (INTERP_EVAL_FLAGS — the SAME table the
// argv0 arm uses, not a re-listed set) followed later in the SAME segment by one
// of its eval flags appears anywhere, ignoring quoted literals. An inline eval
// under a write ban is un-verifiable regardless of where it sits, so refusing
// the form wholesale is the correct posture (intentionally over-blocks a
// read-only `python -c "print(1)"` under a ban). Segment-scoped (splitShellSegments,
// quote-aware) so an eval flag from an unrelated later command can't false-pair.
function commandHasInlineInterpreterEval(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    const tokens = detachTokens(segment);
    for (let i = 0; i < tokens.length; i++) {
      const evalFlags = INTERP_EVAL_FLAGS[execBasename(tokens[i])];
      if (!evalFlags) continue;
      for (let j = i + 1; j < tokens.length; j++) {
        if (evalFlags.has(tokens[j])) return true;
      }
    }
  }
  return false;
}

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
  // detectInlineInterpreterEval (per shell segment, like shell-policy) with a
  // hard "refuse" policy: the ban implies refusal even when the global
  // inline-eval policy is permissive, so a permissive default can't reopen
  // this escape. Intentional over-block: `python -c "print(1)"` is refused
  // under a ban — it can't be verified read-only; the agent should use a read
  // tool or a script file the path guard can see. process.cwd() is the
  // best-effort workspace anchor for the rename-escape arm (this gate has no
  // per-op workspace); the known-interpreter arm doesn't use it at all.
  // splitShellSegments splits on ALL command separators (`|`, `;`, `&&`, `||`,
  // `&`, newlines), not just `|` — otherwise a chained interpreter
  // (`echo hi; python -c "…"`, `true && python -c "…"`, `cd x && node -e "…"`,
  // a newline-chained pair) sat at a non-leading command position that a
  // `|`-only split never isolated, and slipped the ban.
  for (const segment of splitShellSegments(command)) {
    if (detectInlineInterpreterEval(tokenizeCommand(segment), "refuse", process.cwd())) {
      return true;
    }
  }
  // Per-segment above only inspects argv[0]; catch an interpreter buried in a
  // NON-argv0 slot (wrapper/env-prefix/subshell/command-substitution) too.
  if (commandHasInlineInterpreterEval(command)) return true;
  const stripped = stripQuotedSpans(command);
  const redir = stripped.match(/(?:^|\s)\d*>>?\s*([^\s|;&()<>]+)/);
  if (redir && !BENIGN_REDIRECT_TARGET.test(redir[1])) return true;
  return MUTATING_CMD_AT_POS.test(stripped);
}
