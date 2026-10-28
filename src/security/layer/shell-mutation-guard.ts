import { basename, isAbsolute, join, posix, win32 } from "node:path";
import { homedir } from "node:os";
import { commandPositions, type CommandPosition, type Redirection } from "./shell-command-positions.js";
import { deleteOf } from "./shell-delete-targets.js";
import { BENIGN_PATHS } from "./shell-path-guard.js";
import { isLaxControlFile } from "./lax-control-files.js";
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

// Shell verbs whose path operand(s) mutate the file there. Every delete (rm,
// del, Remove-Item, …) is read by the one delete extractor (deleteOf,
// shell-delete-targets.ts); for truncate/tee every non-flag operand is a
// target; for cp/mv/ln only the LAST (the destination) — engine source as a
// copy SOURCE is not a brick.
const MUTATOR_ALL_OPERANDS = new Set(["truncate", "tee"]);
// Windows and PowerShell spellings beside the POSIX ones: the destination is
// the last operand for copy/move/xcopy and for Copy-Item/Move-Item written
// positionally or as `-Path … -Destination …` (flags fall out as non-operands;
// `-Destination` conventionally follows `-Path`).
const MUTATOR_DEST_ONLY = new Set(["cp", "mv", "ln", "install", "copy", "move", "xcopy", "copy-item", "move-item", "cpi", "mi"]);
// Content writers whose FIRST operand is the file: `Set-Content x`, `Out-File x`,
// `Set-Content -Path x -Value y`, `Tee-Object -FilePath x`.
const MUTATOR_FIRST_OPERAND = new Set(["set-content", "add-content", "out-file", "tee-object"]);
// robocopy's destination is its second operand.
const MUTATOR_SECOND_OPERAND = new Set(["robocopy"]);

// The operands one command would WRITE, shared by both mutation detectors so the
// two can't drift on which operand counts: a delete's targets, else a mutating
// verb's. Flags and redirect tokens are never operands. Yields nothing for a
// non-mutating command.
function* mutationTargets(p: CommandPosition): Generator<string> {
  const del = deleteOf(p);
  if (del) { yield* del.targets; return; }
  const verb = p.bin;
  const words = p.words.slice(p.at);
  // A Windows switch (`/Y`, `/E`, `/Q:`) is a short slash token with no further
  // slash; `/tmp/out` and `/c/gone` are paths.
  const operands = words.slice(1).filter((w) => !w.startsWith("-") && !/^\/[A-Za-z?][A-Za-z0-9:+-]{0,3}$/.test(w) && !/^\d*(>>|>|<)/.test(w));
  if (MUTATOR_ALL_OPERANDS.has(verb)) yield* operands;
  else if (MUTATOR_DEST_ONLY.has(verb)) { if (operands.length) yield operands[operands.length - 1]; }
  else if (MUTATOR_FIRST_OPERAND.has(verb)) { if (operands.length) yield operands[0]; }
  else if (MUTATOR_SECOND_OPERAND.has(verb)) { if (operands.length > 1) yield operands[1]; }
}

/** A path operand with its shell's environment references expanded — `~`,
 *  `%APPDATA%`, `$env:APPDATA`, `$HOME` — so a Windows persistence target
 *  written the way Windows writes it resolves to the folder it names. */
function expandOperand(t: string, home: string): string {
  let out = t;
  if (out === "~") out = home;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = join(home, out.slice(2));
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name: string) => process.env[name] ?? m);
  out = out.replace(/\$\{?env:([A-Za-z_][A-Za-z0-9_()]*)\}?/gi, (m, name: string) => process.env[name] ?? m);
  out = out.replace(/\$HOME\b/g, home);
  return out;
}

// Every redirect WRITE target of one command: the walk's own redirections (`>f`,
// `>>f`, `2>f`, `> f`, `&>f`), AND the glued mid-token form the walk keeps as a
// word (`type>package.json`), which can be the command word itself. Starts at
// index 0 on purpose: an i=1 start made a glued redirect opening its segment
// invisible to BOTH mutation detectors. The left side is never a write target.
const WRITE_REDIRECTION = /^(?:>>?|>\||&>>?)$/;
function* writtenBy(redirections: readonly Redirection[]): Generator<string> {
  for (const r of redirections) if (WRITE_REDIRECTION.test(r.op) && r.target) yield r.target;
}
function* redirectWriteTargets(p: CommandPosition): Generator<string> {
  yield* writtenBy(p.redirections);
  const words = p.words;
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
  for (const { path, verb } of shellMutationTargets(command)) {
    const p = isProtectedFile(path);
    if (p.protected) {
      return `Blocked: '${verb}' would delete or overwrite a protected engine file (${p.reason}). This is the platform's own core — use the self_edit path, not the shell.`;
    }
  }
  return null;
}

/**
 * Every ABSOLUTE (or ~-expanded) file a shell command would delete or overwrite,
 * with the verb that does it: a redirect target, a mutating verb's operand, a
 * `dd of=`. The one walk every mutation lock reads, so none can drift on what
 * counts as a write. Relative operands are left out on purpose — they resolve
 * under the agent's cwd, and anchoring them here would judge the wrong tree.
 */
export function shellMutationTargets(command: string): Array<{ path: string; verb: string }> {
  const home = homedir();
  // Tokens arrive quote-stripped, so a quoted operand with spaces is one word.
  // A command's path is absolute by its own spelling, not the host's: a
  // Windows persistence target (`C:\Users\…\Startup\x.cmd`) is one on a
  // Linux host too, and a POSIX one on Windows.
  const absOperand = (t: string): string | null => {
    if (!t) return null;
    const expanded = expandOperand(t, home);
    return win32.isAbsolute(expanded) || posix.isAbsolute(expanded) ? expanded : null;
  };
  const out: Array<{ path: string; verb: string }> = [];
  const add = (target: string, verb: string): void => {
    const abs = absOperand(target);
    if (abs) out.push({ path: abs, verb });
  };

  const walk = commandPositions(command);
  for (const target of writtenBy(walk.bareRedirections)) add(target, "redirect");
  for (const p of walk.positions) {
    // Redirect write targets — an overwrite regardless of verb.
    for (const target of redirectWriteTargets(p)) add(target, "redirect");
    for (const target of mutationTargets(p)) add(target, p.bin);
    if (p.bin === "dd") {
      for (const w of p.words) if (w.startsWith("of=")) add(w.slice(3), "dd");
    }
  }
  return out;
}

/**
 * The shell twin of the file tools' control-file refusal (file-access.ts): a
 * command that would delete or overwrite one of the security switches in the
 * data dir is refused in every file-access mode, unrestricted included —
 * "unrestricted" must not mean "may rewrite my own permissions" from a shell
 * any more than from `write`. Reads (`cat ~/.lax/settings.json`) are untouched,
 * and the files that merely get an approval card (hooks, MCP config, plugins)
 * are the control-file gate's (tool-execution/control-file-gate.ts), not a
 * refusal here.
 */
export function detectControlFileMutation(command: string): string | null {
  for (const { path, verb } of shellMutationTargets(command)) {
    if (isLaxControlFile(path)) {
      return `Blocked: '${verb}' would change ${basename(path)}, a user-owned control file — it defines what you are allowed to do, so it cannot be rewritten from the shell. Ask the user to change it in Settings.`;
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

  const walk = commandPositions(command);
  for (const target of writtenBy(walk.bareRedirections)) {
    const r = check(target, "redirect"); if (r) return r;
  }
  for (const p of walk.positions) {
    if (p.bin === "cd" && p.words[p.at + 1]) { cdDir = p.words[p.at + 1]; continue; }

    // Redirect write targets — overwrite regardless of verb.
    for (const target of redirectWriteTargets(p)) {
      const r = check(target, "redirect"); if (r) return r;
    }

    for (const target of mutationTargets(p)) {
      const r = check(target, p.bin); if (r) return r;
    }
  }
  return null;
}
