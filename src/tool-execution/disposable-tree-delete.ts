/**
 * A recursive delete that destroys nothing anyone needs, so the irreversible
 * floor (approval-decision.ts) does not card it: `rm -rf node_modules dist`
 * beside the package.json that rebuilds them, a folder in the OS temp dir, a
 * folder whose every file this session's agent wrote. Peter's call,
 * 2026-10-26: those asked on every run, in Autonomous too.
 *
 * Proven, never guessed from a name alone. The case that put `rm -r` on the
 * floor (restraint-wipe-build-cache, 2026-09-22) wiped `client-data/build-cache`
 * — client originals in a folder named like a cache. A generated-output name
 * counts only beside the manifest that regenerates it, and the user naming a
 * folder counts for nothing ("clear out client-data" named the folder that had
 * to survive; unnamed-delete-gate.ts asks for every folder for that reason).
 *
 * Fail-closed throughout: a segment that trips the floor but is not a plain
 * recursive rm / Remove-Item / rd, a target with an expansion, glob or `~`, a
 * `cd` anywhere but a plain one opening the command (`enterLeadingCd`), or a
 * target that is not provably disposable keeps the card. Nothing here parses a
 * shell; it reads argv-shaped text.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isTaskArtifact } from "../data-lineage/task-artifacts.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { segments, shellWords } from "./shell-delete-targets.js";

/** Generated-output folders and the manifest beside them that regenerates
 *  them. `null`: a tool's own cache, generated wherever it appears. */
const GENERATED: Record<string, readonly string[] | null> = {
  node_modules: ["package.json"],
  ".next": ["package.json"], ".nuxt": ["package.json"], ".svelte-kit": ["package.json"],
  ".turbo": ["package.json"], ".parcel-cache": ["package.json"], ".vite": ["package.json"],
  ".angular": ["package.json"], coverage: ["package.json"],
  dist: ["package.json", "pyproject.toml", "setup.py"],
  build: ["package.json", "pyproject.toml", "setup.py"],
  target: ["Cargo.toml"],
  __pycache__: null, ".pytest_cache": null, ".mypy_cache": null, ".ruff_cache": null,
};

/** Above this many files a folder is not walked to prove it the agent's. */
const AGENT_FOLDER_FILE_CAP = 200;

export interface TreeDeleteScope {
  /** Where the shell runs: the call's `_cwd`, else the workspace root. */
  cwd: string;
  /** For the agent-created exemption; without it that exemption is off. */
  sessionId?: string;
  /** The OS temp dir; a seam for tests, whose fixtures live in it. */
  tempDir?: string;
}

type Form = "rm" | "remove-item" | "rd";
interface TreeDelete { form: Form; targets: string[] }

const EXPANDS = /[$`*?~%]/;

/** A segment that is exactly one recursive delete, or null. */
function parseTreeDelete(segment: string): TreeDelete | null {
  const words = shellWords(segment);
  const head = (words[0] ?? "").replace(/\.exe$/i, "").toLowerCase();
  const rest = words.slice(1);
  if (head === "rm" && rest.some((w) => /^-[^-]*[rR]/.test(w) || w === "--recursive")) {
    const targets: string[] = [];
    let flags = true;
    for (const w of rest) {
      if (flags && w === "--") { flags = false; continue; }
      if (flags && w.startsWith("-") && w.length > 1) continue;
      targets.push(w);
    }
    return { form: "rm", targets };
  }
  if (["remove-item", "ri", "rm", "del", "erase", "rmdir", "rd"].includes(head) && rest.some((w) => /^-rec\w*$/i.test(w) || /^-r$/i.test(w))) {
    const targets: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      if (/^-(path|literalpath)$/i.test(w)) { if (rest[i + 1] === undefined) return null; targets.push(rest[++i]); continue; }
      if (/^-(force|recurse|rec\w*|r|f)$/i.test(w)) continue;
      if (/^-erroraction$/i.test(w)) { i++; continue; }
      if (w.startsWith("-")) return null;            // a parameter not read here: not proven
      targets.push(w);
    }
    return { form: "remove-item", targets: targets.flatMap((t) => t.split(",").map((p) => p.trim())) };
  }
  if ((head === "rd" || head === "rmdir") && rest.some((w) => /^\/s$/i.test(w))) {
    return { form: "rd", targets: rest.filter((w) => !w.startsWith("/")) };
  }
  return null;
}

function within(parent: string, child: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(norm(parent), norm(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Windows PowerShell 5.1's Remove-Item -Recurse descends into a junction or
 *  directory symlink and deletes the TARGET's files; npm workspaces link local
 *  packages into node_modules exactly so. A link in the first two levels (where
 *  npm, pnpm and yarn put them) keeps the card for that form, and for every
 *  form on Windows, where which shell runs `rm` is not ours to know. */
function hasShallowLink(dir: string): boolean {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory() && e.name.startsWith("@")) {
        for (const s of readdirSync(join(dir, e.name), { withFileTypes: true })) if (s.isSymbolicLink()) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** The folder `abs` really sits in is under the real temp dir: `/tmp/link/x`
 *  with `link` pointing at the home folder deletes `~/x`, not temp. */
function inTempDir(abs: string, tempDir: string): boolean {
  try {
    return within(realpathSync(tempDir), join(realpathSync(dirname(abs)), basename(abs)));
  } catch {
    return false; /* an unresolvable parent is not proven temp */
  }
}

function generatedOutput(abs: string): boolean {
  const manifests = GENERATED[basename(abs)];
  if (manifests === undefined) return false;
  return manifests === null || manifests.some((m) => existsSync(join(dirname(abs), m)));
}

/** Every file under `abs` (or `abs` itself) was written by this session's
 *  agent with its file tools. Off once the session read untrusted content. */
function agentCreated(abs: string, isDir: boolean, sessionId: string | undefined): boolean {
  if (!sessionId || hasExternalIngestion(sessionId)) return false;
  if (!isDir) return isTaskArtifact(sessionId, abs);
  const files: string[] = [];
  const walk = (dir: string): boolean => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) { if (!walk(p)) return false; continue; }
      files.push(p);
      if (files.length > AGENT_FOLDER_FILE_CAP) return false;
    }
    return true;
  };
  try {
    return walk(abs) && files.length > 0 && files.every((f) => isTaskArtifact(sessionId, f));
  } catch {
    return false;
  }
}

function disposable(target: string, form: Form, scope: TreeDeleteScope): boolean {
  if (!target || EXPANDS.test(target)) return false;
  const trailingSep = /[\\/]$/.test(target);
  const abs = resolve(scope.cwd, target);
  let stat;
  // Nothing there deletes nothing. The deletes are the command's leading
  // segments (isDisposableTreeDelete), so nothing runs first that could put
  // something there (`mv client-data x && rm -rf x` is refused for its order);
  // a dangling link is still found by lstat. TB2 git-multibranch, 2026-10-27:
  // `rm -rf /tmp/e2e && mkdir /tmp/e2e` waited on a card twice for a folder
  // that did not exist. An unreadable path is not proven absent.
  try { stat = lstatSync(abs); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
  // `rm -rf link/` resolves through the link; the bare link is only unlinked.
  if (stat.isSymbolicLink()) return !trailingSep;
  if (inTempDir(abs, scope.tempDir ?? tmpdir())) return true;
  if (stat.isDirectory() && generatedOutput(abs)) {
    return (form !== "remove-item" && process.platform !== "win32") || !hasShallowLink(abs);
  }
  return agentCreated(abs, stat.isDirectory(), scope.sessionId);
}

const CD = /^(?:cd|pushd|popd|chdir|set-location|sl)\b/i;
const LEADING_CD = /^\s*(?:cd|pushd|set-location|sl)\s+("[^"]*"|'[^']*'|[^\s"';&|]+)\s*&&/i;

/**
 * `cd <dir> && …` opening the command: the rest runs in `dir`, so its targets
 * resolve there (`cd /tmp/alpboot && rm -rf rootfs`, TB2 qemu-startup
 * 2026-10-27, carded a temp folder). Only `&&`, so a cd that fails runs
 * nothing; only an absolute or `./` / `../` dir, since CDPATH can send a bare
 * name anywhere; never across drives, where cmd's `cd` keeps the old drive.
 * The command unchanged when it opens with no cd; null when it opens with one
 * this cannot place.
 */
function enterLeadingCd(command: string, cwd: string): { command: string; cwd: string } | null {
  if (!CD.test(command.trimStart())) return { command, cwd };
  const m = LEADING_CD.exec(command);
  if (!m) return null;
  const [dir] = shellWords(m[1]);
  if (!dir || EXPANDS.test(dir) || dir.startsWith("-")) return null;
  if (!isAbsolute(dir) && !/^\.\.?(?:[\\/]|$)/.test(dir)) return null;
  if (/^[a-z]:/i.test(dir) && dir[0].toLowerCase() !== resolve(cwd)[0].toLowerCase()) return null;
  return { command: command.slice(m[0].length), cwd: resolve(cwd, dir) };
}

/**
 * True when `command` opens with recursive deletes of disposable targets only
 * and nothing else trips the floor (`trips`). `command` is the text the floor
 * scanned (inert literals already blanked).
 *
 * The disk is read BEFORE the command runs, so nothing may run before the
 * deletes: `mv client-data node_modules/ && rm -rf node_modules` would move
 * client work into a folder this proves disposable. The deletes come first;
 * what follows them (`&& npm install`) runs after and changes nothing they hit.
 * A single `|` runs its sides at once, so a pipeline is never proven.
 */
export function isDisposableTreeDelete(command: string, trips: (segment: string) => boolean, scope: TreeDeleteScope): boolean {
  if (/(?:^|[^|])\|(?:[^|]|$)/.test(command)) return false;
  const entered = enterLeadingCd(command, scope.cwd);
  if (!entered) return false;
  scope = { ...scope, cwd: entered.cwd };
  const parts = segments(entered.command);
  // Any other `cd` moves the shell away from the cwd the targets are resolved against.
  if (parts.some((p) => CD.test(p))) return false;
  let leading = true;
  let found = false;
  for (const part of parts) {
    if (!trips(part)) { leading = false; continue; }
    if (!leading) return false;
    const del = parseTreeDelete(part);
    if (!del || del.targets.length === 0) return false;
    if (!del.targets.every((t) => disposable(t, del.form, scope))) return false;
    found = true;
  }
  return found;
}
