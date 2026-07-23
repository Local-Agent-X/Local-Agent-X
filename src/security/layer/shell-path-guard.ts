import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import type { FileAccessMode, InlineEvalPolicy } from "./types.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";
import { isProtectedFile } from "../../config-loader.js";
import { isLockedBaselinePath } from "../../tools/app-tools/write-guard.js";

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
// runtime (`$VAR`, `$(...)`) — when the spawn is UNCONFINED, shell-policy
// blocks command substitution, chaining, and `${}`, so those avenues are
// mostly closed upstream; under a CONFINED backend those string rules stand
// down and the kernel cage itself (credential-path denials enforced on the
// whole process tree) is the wall the runtime-only path can't cross. The
// dedicated tools remain the real wall for file work.
//
// Single source of truth: the per-path decision is evaluateFileAccess — the
// exact gate the file tools use — so the mode means the same thing everywhere.

export interface ShellPathGuardCtx {
  workspace: string;
  fileAccessMode: FileAccessMode;
  // Inline-eval (R4-11/R4-13) policy — independent of fileAccessMode. Optional
  // so callers that omit it fail SAFE: an unset policy refuses inline-eval.
  inlineEvalPolicy?: InlineEvalPolicy;
  // EFFECTIVE OS-level confinement of the spawn being vetted — callers derive
  // it from getSandboxStatus().confined (false when a guarded selection FELL
  // BACK to host). Gates ONLY the structural string heuristics in
  // evaluateShellCommand (substitution/separators/pipe-cap/script-write/
  // interpreter-escape/inline-eval-form); the egress, rm, denylist, and
  // file-access rules ignore it. Optional so callers that omit it fail SAFE
  // (treated as unconfined → every rule applies).
  sandboxConfined?: boolean;
  allowedPathCheck: (realPath: string, sessionId?: string) => boolean;
  sessionId?: string;
}

// Device sinks that are always fine as a target, both platforms. A redirect to
// /dev/null must not read as "escaping the workspace".
const BENIGN_PATHS = new Set([
  "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/tty",
  "nul", "con", "/dev/fd/1", "/dev/fd/2",
]);

const WINDOWS_SLASH_SWITCH_COMMANDS = new Set([
  "attrib", "cmd", "find", "findstr", "icacls", "reg", "robocopy", "taskkill", "tasklist", "where", "xcopy",
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
  // Thread the inline-eval policy + workspace into the command scan so the
  // R4-11/R4-13 inline-eval interpreter-escape refusal can gate on its own
  // policy (NOT the file-access mode) and resolve the rename-escape path against
  // the workspace tree. Unset policy → "refuse" (fail safe). This is the
  // canonical seam; the redundant secondary scan in process-session runs AFTER it.
  // platform is left to its default (process.platform); ctx.sandboxConfined
  // rides through so the structural heuristics can stand down under a
  // confined backend (see evaluateShellCommand).
  const cmdDecision = evaluateShellCommand(command, ctx.inlineEvalPolicy ?? "refuse", ctx.workspace, ctx.fileAccessMode, undefined, ctx.sandboxConfined);
  if (!cmdDecision.allowed) return cmdDecision;
  // ALWAYS-ON (mode-independent) self-brick guard: refuse a shell command that
  // would DELETE or OVERWRITE the platform's own protected engine source. The
  // dedicated write/edit/delete_file tools are already gated by protected-files
  // (resolve-tool.ts), but bash was NOT — so `rm -rf <repo>/src/security` bricked
  // the engine even in unrestricted mode. Same authority (isProtectedFile), so
  // the two can't drift.
  const engine = detectProtectedEngineMutation(command);
  if (engine) return { allowed: false, reason: engine, userHint: USER_HINTS.secrets };
  // ALWAYS-ON (mode-independent) scaffold-baseline lock: the write/edit tools
  // reject clobbering a harness-generated app skeleton (write-guard.ts), but
  // bash could redirect/cp/mv/rm over the same file and walk past it. Same
  // manifest is the authority, so the two can't drift.
  const baseline = detectLockedBaselineMutation(command, ctx.workspace);
  if (baseline) return { allowed: false, reason: baseline, userHint: USER_HINTS.commandShell };
  return evaluateShellPaths(command, ctx);
}

// Shell verbs whose ABSOLUTE path operand(s) mutate the file at that path.
// For rm/shred/unlink/truncate/tee every non-flag operand is a target; for
// cp/mv/ln only the LAST operand (the destination) is written — reading engine
// source as a copy SOURCE is not a brick, so those aren't flagged.
const MUTATOR_ALL_OPERANDS = new Set(["rm", "shred", "unlink", "truncate", "tee"]);
const MUTATOR_DEST_ONLY = new Set(["cp", "mv", "ln", "install"]);

/**
 * If a shell command would delete or overwrite a protected engine file, return
 * a block reason; else null. Only ABSOLUTE (and ~-expanded) operands are checked
 * — a relative operand resolves under the agent's workspace/worktree cwd, which
 * is a different tree from the engine (isProtectedFile would only be reachable
 * via the platform root, and anchoring a relative token there would false-block
 * ordinary user-app files like apps/foo/src/index.ts). isProtectedFile returns
 * not-protected for any absolute path outside the engine tree, so this never
 * fires on the user's own files.
 */
export function detectProtectedEngineMutation(command: string): string | null {
  const home = homedir();
  const absOperand = (tok: string): string | null => {
    let t = stripQuotes(tok);
    if (!t) return null;
    if (t === "~") t = home;
    else if (t.startsWith("~/") || t.startsWith("~\\")) t = join(home, t.slice(2));
    return isAbsolute(t) ? t : null;
  };
  const hit = (abs: string, verb: string): string | null => {
    const p = isProtectedFile(abs);
    return p.protected
      ? `Blocked: '${verb}' would delete or overwrite a protected engine file (${p.reason}). This is the platform's own core — use the self_edit path, not the shell.`
      : null;
  };

  for (const segment of command.split("|")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const verb = (stripQuotes(words[0]).split(/[\\/]/).pop() || "").toLowerCase();

    // Redirect write targets (`>f`, `>>f`, `2>f`, and `> f` / `>> f`) — an
    // overwrite of the engine regardless of the verb.
    for (let i = 1; i < words.length; i++) {
      const m = words[i].match(/^\d*(>>|>)(.*)$/);
      if (!m) continue;
      let target = m[2];
      if (!target && i + 1 < words.length) target = words[++i];
      const abs = target ? absOperand(target) : null;
      if (abs) { const r = hit(abs, "redirect"); if (r) return r; }
    }

    if (MUTATOR_ALL_OPERANDS.has(verb)) {
      for (let i = 1; i < words.length; i++) {
        if (words[i].startsWith("-") || /^\d*(>>|>|<)/.test(words[i])) continue;
        const abs = absOperand(words[i]);
        if (abs) { const r = hit(abs, verb); if (r) return r; }
      }
    } else if (MUTATOR_DEST_ONLY.has(verb)) {
      const operands = words.slice(1).filter((w) => !w.startsWith("-") && !/^\d*(>>|>|<)/.test(w));
      const dest = operands[operands.length - 1];
      const abs = dest ? absOperand(dest) : null;
      if (abs) { const r = hit(abs, verb); if (r) return r; }
    } else if (verb === "dd") {
      for (const w of words) {
        if (!w.startsWith("of=")) continue;
        const abs = absOperand(w.slice(3));
        if (abs) { const r = hit(abs, "dd"); if (r) return r; }
      }
    }
  }
  return null;
}

/**
 * Shell twin of the write/edit baseline lock. Returns a block reason if a shell
 * command would overwrite or delete a file that an app's scaffold manifest marks
 * as harness-owned (package.json / vite.config / tsconfig); else null.
 * `isLockedBaselinePath` reads that per-app manifest, so a manifest-less app
 * (full-stack / static / non-scaffolded) is never touched — the lock stays
 * scoped exactly as the write-guard scopes it.
 *
 * Best-effort, same class as detectProtectedEngineMutation: it resolves absolute
 * targets and relative targets anchored by an `apps/<id>/…` shape (including a
 * leading `cd <dir> &&`), then asks the manifest. It does NOT catch a bare
 * relative write whose app cwd is only known at runtime, an `npm pkg set`, or an
 * `npm create --force` re-scaffold — those are conceded here (the write/edit
 * lock already covers the common vector, and the sound wall is OS-level
 * confinement, per this file's header). FP-safe by construction: it only fires
 * when the resolved path genuinely lands on a manifest-listed baseline file.
 */
export function detectLockedBaselineMutation(command: string, workspace: string): string | null {
  const cdMatch = command.match(/^\s*cd\s+(['"]?[^'"\s&|;]+['"]?)\s*&&/);
  const cdDir = cdMatch ? stripQuotes(cdMatch[1]) : "";

  const resolved = (rawTarget: string): string[] => {
    const t = stripQuotes(rawTarget);
    if (!t || BENIGN_PATHS.has(t.toLowerCase())) return [];
    const out: string[] = [];
    if (isAbsolute(t)) out.push(t);
    // A relative target lands in the app tree only if it (or `cd <dir>/` + it)
    // carries an `apps/<id>/…` tail; re-anchor that tail under the workspace.
    const combined = (cdDir ? `${cdDir}/${t}` : t).replace(/\\/g, "/");
    const tail = combined.match(/(?:^|\/)(apps\/[^/]+\/.+)$/);
    if (tail) out.push(join(workspace, tail[1]));
    return out;
  };

  const check = (rawTarget: string, verb: string): string | null => {
    for (const abs of resolved(rawTarget)) {
      if (isLockedBaselinePath(abs)) {
        return (
          `Blocked: '${verb}' would overwrite a harness-locked project baseline file ` +
          `(package.json / vite.config / tsconfig). Add your app code under src/, and change ` +
          `dependencies with \`npm install <pkg>\` — the shell can't do what the write/edit lock forbids.`
        );
      }
    }
    return null;
  };

  for (const segment of command.split("|")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const verb = (stripQuotes(words[0]).split(/[\\/]/).pop() || "").toLowerCase();

    // Redirect write targets (`>f`, `>> f`, `> f`) — overwrite regardless of verb.
    for (let i = 1; i < words.length; i++) {
      const m = words[i].match(/^\d*(>>|>)(.*)$/);
      if (!m) continue;
      let target = m[2];
      if (!target && i + 1 < words.length) target = words[++i];
      if (target) { const r = check(target, "redirect"); if (r) return r; }
    }

    if (MUTATOR_ALL_OPERANDS.has(verb)) {
      // rm/shred/unlink/truncate/tee — every non-flag operand is a target.
      for (let i = 1; i < words.length; i++) {
        if (words[i].startsWith("-") || /^\d*(>>|>|<)/.test(words[i])) continue;
        const r = check(words[i], verb); if (r) return r;
      }
    } else if (MUTATOR_DEST_ONLY.has(verb)) {
      // cp/mv/ln/install — only the last operand (destination) is written.
      const operands = words.slice(1).filter((w) => !w.startsWith("-") && !/^\d*(>>|>|<)/.test(w));
      const dest = operands[operands.length - 1];
      if (dest) { const r = check(dest, verb); if (r) return r; }
    }
  }
  return null;
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
    const verb = (stripQuotes(words[0] ?? "").split(/[\\/]/).pop() || "").toLowerCase().replace(/\.exe$/, "");
    // i starts at 1: skip the executable name (a system binary path is fine).
    for (let i = 1; i < words.length; i++) {
      let raw = words[i];
      if (!raw) continue;
      if (
        process.platform === "win32" &&
        WINDOWS_SLASH_SWITCH_COMMANDS.has(verb) &&
        /^\/[A-Za-z?][A-Za-z0-9?-]*(?::[^\\/]*)?$/.test(raw)
      ) continue;

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
