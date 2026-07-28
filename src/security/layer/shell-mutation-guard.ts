import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import {
  execBasename, splitShellSegments, tokenizeCommand,
} from "./shell-lex.js";
import { BENIGN_PATHS } from "./shell-path-guard.js";
import { isProtectedFile } from "../../config-loader.js";
import { isLockedBaselinePath } from "../../tools/app-tools/write-guard.js";

// ── Always-on (mode-independent) shell MUTATION locks ──
//
// Two detectors that refuse a shell command which would DELETE or OVERWRITE a
// file another enforcement point already protects: the platform's own engine
// source (isProtectedFile, the authority resolve-tool.ts uses for write/edit/
// delete_file) and a harness-generated app scaffold baseline (isLockedBaselinePath,
// the authority write-guard.ts uses). Both are called by evaluateShellCommandAndPaths
// in shell-path-guard.ts, which owns the file-access confinement concern; these
// locks are independent of fileAccessMode and fire even in unrestricted mode.

// Shell verbs whose path operand(s) mutate the file there. For rm/shred/unlink/
// truncate/tee every non-flag operand is a target; for cp/mv/ln only the LAST (the
// destination) — engine source as a copy SOURCE is not a brick.
const MUTATOR_ALL_OPERANDS = new Set(["rm", "shred", "unlink", "truncate", "tee"]);
const MUTATOR_DEST_ONLY = new Set(["cp", "mv", "ln", "install"]);

// The operands a mutating verb would WRITE, shared by both mutation detectors so
// the two can't drift on which operand counts. Flags and redirect tokens are never
// operands. Yields nothing for a non-mutating verb.
function* mutationTargets(words: string[], verb: string): Generator<string> {
  if (!MUTATOR_ALL_OPERANDS.has(verb) && !MUTATOR_DEST_ONLY.has(verb)) return;
  const operands = words.slice(1).filter((w) => !w.startsWith("-") && !/^\d*(>>|>|<)/.test(w));
  if (MUTATOR_ALL_OPERANDS.has(verb)) yield* operands;
  else if (operands.length) yield operands[operands.length - 1];
}

// Every redirect WRITE target in a token list: `>f`, `>>f`, `2>f`, a bare `>` with
// the target as the NEXT word, AND the glued mid-token form (`type>package.json`).
// Starts at index 0 on purpose: once splitShellSegments splits on `; && || &`, a
// glued redirect is the FIRST token of its own segment, so an i=1 start made it
// invisible to BOTH mutation detectors. The left side is never a write target.
function* redirectWriteTargets(words: string[]): Generator<string> {
  for (let i = 0; i < words.length; i++) {
    const m = words[i].match(/^(.*?)(\d*)(>>|>)(.*)$/);
    if (!m) continue;
    let target = m[4];
    if (!target && i + 1 < words.length) target = words[++i];
    if (target) yield target;
  }
}

/**
 * If a shell command would delete or overwrite a protected engine file, return a
 * block reason; else null. Only ABSOLUTE (and ~-expanded) operands are checked — a
 * relative operand resolves under the agent's workspace/worktree cwd, a different
 * tree from the engine (anchoring it at the platform root would false-block user-app
 * files like apps/foo/src/index.ts). isProtectedFile is not-protected for any
 * absolute path outside the engine tree, so this never fires on the user's files.
 */
export function detectProtectedEngineMutation(command: string): string | null {
  const home = homedir();
  // Tokens arrive quote-stripped, so a quoted operand with spaces is one word.
  const absOperand = (t: string): string | null => {
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

  for (const segment of splitShellSegments(command)) {
    const words = tokenizeCommand(segment);
    if (!words.length) continue;
    const verb = execBasename(words[0]);

    // Redirect write targets — an overwrite of the engine regardless of verb.
    for (const target of redirectWriteTargets(words)) {
      const abs = absOperand(target);
      if (abs) { const r = hit(abs, "redirect"); if (r) return r; }
    }

    for (const target of mutationTargets(words, verb)) {
      const abs = absOperand(target);
      if (abs) { const r = hit(abs, verb); if (r) return r; }
    }
    if (verb === "dd") {
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
 * (full-stack / static / non-scaffolded) is never touched — the lock stays scoped
 * exactly as the write-guard scopes it.
 *
 * Best-effort, same class as detectProtectedEngineMutation: it resolves absolute
 * targets and relative targets anchored by an `apps/<id>/…` shape (including a
 * preceding `cd <dir>` segment), then asks the manifest. It does NOT catch a bare
 * relative write whose app cwd is only known at runtime, an `npm pkg set`, or an
 * `npm create --force` re-scaffold — conceded here (the write/edit lock covers the
 * common vector; the sound wall is OS-level confinement, per the header of
 * shell-path-guard.ts).
 * FP-safe: it fires only when the resolved path lands on a manifest-listed file.
 */
export function detectLockedBaselineMutation(command: string, workspace: string): string | null {
  // Cwd anchor from the most recent `cd <dir>` segment in the walk below, so `cd
  // apps/foo && echo x > package.json` (or a `;`-chained form) resolves the relative
  // target under the cd'd dir. A quoted cd dir with spaces anchors too.
  let cdDir = "";

  const resolved = (t: string): string[] => {
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

  for (const segment of splitShellSegments(command)) {
    const words = tokenizeCommand(segment);
    if (!words.length) continue;
    const verb = execBasename(words[0]);
    if (verb === "cd" && words[1]) { cdDir = words[1]; continue; }

    // Redirect write targets — overwrite regardless of verb.
    for (const target of redirectWriteTargets(words)) {
      const r = check(target, "redirect"); if (r) return r;
    }

    for (const target of mutationTargets(words, verb)) {
      const r = check(target, verb); if (r) return r;
    }
  }
  return null;
}
