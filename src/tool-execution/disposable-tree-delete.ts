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
 * command before a delete that could move data onto its target or change
 * what the delete runs (delete-prefix.ts), a folder no `cd` rule can place, or
 * a target that is not provably disposable keeps the card. The deletes are
 * read by the one delete extractor (src/security/layer/shell-delete-targets.ts).
 *
 * The same proof clears a single-file shell delete for the un-named-delete
 * gate (`disposableFileDeletes`): a file in the temp dir, one that is not
 * there, or one that holds no data (no-data-paths.ts) is nobody's.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isTaskArtifact } from "../data-lineage/task-artifacts.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { plainDelete, shellDeletes, type DeleteVerb } from "../security/layer/shell-delete-targets.js";
import { shellSegments } from "../security/layer/shell-lex.js";
import { agentMadeFolderHoldsOnlyNew } from "./agent-made-folder.js";
import { cdCannotFail, deleteLine, priorRunsLeave, runsAlone } from "./delete-prefix.js";
import { globHoldsNoData, holdsNoData } from "./no-data-paths.js";

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

const EXPANDS = /[$`*?~%]/;

/** The targets of a segment that is exactly one recursive delete, by no
 *  wrapper (a `sudo` or `bash -c` delete is not proven), naming every target
 *  it removes: a PowerShell filter (`-Filter`, `-Include`) and `del /s`, which
 *  also deletes same-named files in every subfolder, are not proven. */
function treeDeleteOf(segment: string): { verb: DeleteVerb; targets: string[] } | null {
  const del = plainDelete(segment);
  if (!del || !del.recursive || del.opaque || del.verb === "del" || del.targets.length === 0) return null;
  return { verb: del.verb, targets: del.targets };
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
/** A glob whose folder is not there matches nothing, so deletes nothing — as
 *  a path not there does (disposable). What runs before the delete may not
 *  move anything into that folder (priorRunsLeave on prefixTarget). TB2
 *  configure-git-webserver, 2026-10-28: `rm -rf key*` in a folder the script
 *  makes with `mkdir -p` one line earlier. */
function globFolderAbsent(abs: string): boolean {
  try { lstatSync(dirname(abs)); return false; } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
}

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

/** A Python virtual environment: `python -m venv`, virtualenv and uv all write
 *  `pyvenv.cfg` at its root, whatever the folder is called. It holds an
 *  interpreter link and packages installed from an index; the project's code
 *  lives outside it. */
function virtualEnv(abs: string): boolean {
  try { return lstatSync(join(abs, "pyvenv.cfg")).isFile(); } catch { return false; /* no marker: not a venv */ }
}

/** A target this cannot place on disk: an expansion, and on Windows a `/x/…`
 *  or `\\x\…` path, which is Git Bash's mount or a share, not `<drive>:\x\…`.
 *  Resolved here it would name another path, one that reads as absent. */
function unplaceable(target: string): boolean {
  return /[$`~%]/.test(target) || (process.platform === "win32" && /^[\\/]/.test(target));
}

/** Every file under `abs` (or `abs` itself) was written by this session's
 *  agent with its file tools, or `abs` is a folder its command made that holds
 *  nothing older than itself (agent-made-folder.ts). Off once the session read
 *  untrusted content. */
function agentCreated(abs: string, isDir: boolean, sessionId: string | undefined): boolean {
  if (!sessionId || hasExternalIngestion(sessionId)) return false;
  if (!isDir) return isTaskArtifact(sessionId, abs);
  if (agentMadeFolderHoldsOnlyNew(abs, sessionId)) return true;
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

function disposable(target: string, verb: DeleteVerb, scope: TreeDeleteScope): boolean {
  if (disposableGlob(target, verb, scope)) return true;
  if (!target || EXPANDS.test(target) || unplaceable(target)) return false;
  const trailingSep = /[\\/]$/.test(target);
  const abs = resolve(scope.cwd, target);
  let stat;
  // Nothing there deletes nothing. Nothing the command runs before the delete
  // may put something there (priorRunsLeave: `mv client-data x && rm -rf x`
  // is refused for its move); a dangling link is still found by lstat. TB2
  // git-multibranch, 2026-10-27: `rm -rf /tmp/e2e && mkdir /tmp/e2e` waited on
  // a card twice for a folder that did not exist. An unreadable path is not
  // proven absent.
  try { stat = lstatSync(abs); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
  // `rm -rf link/` resolves through the link; the bare link is only unlinked.
  if (stat.isSymbolicLink()) return !trailingSep;
  if (inTempDir(abs, scope.tempDir ?? tmpdir())) return true;
  if (stat.isDirectory() && (generatedOutput(abs) || virtualEnv(abs))) {
    return (verb !== "remove-item" && process.platform !== "win32") || !hasShallowLink(abs);
  }
  return holdsNoData(abs, stat, trailingSep) || agentCreated(abs, stat.isDirectory(), scope.sessionId);
}

/** A glob in the last segment whose every match is disposable: under the real
 *  temp dir, or what globHoldsNoData proves (a system cache folder's
 *  contents, `rm -rf /var/lib/apt/lists/*`). TB2 build-pmars (2026-10-27):
 *  `cd /tmp && rm -rf pmars*` waited on a card twice. Never with a trailing
 *  separator (the glob then a slash would follow a matched link out of temp;
 *  bare, rm only unlinks it), and never for Remove-Item or on Windows, where a
 *  recursive delete follows a junction and the matches are not inspected
 *  here. */
function disposableGlob(target: string, verb: DeleteVerb, scope: TreeDeleteScope): boolean {
  if (!target || /[$`~%]/.test(target) || /[\\/]$/.test(target) || unplaceable(target)) return false;
  if (verb === "remove-item" || process.platform === "win32") return false;
  const abs = resolve(scope.cwd, target);
  if (GLOB.test(dirname(abs)) || !GLOB.test(basename(abs))) return false;
  return globFolderAbsent(abs) || inTempDir(join(dirname(abs), "_"), scope.tempDir ?? tmpdir()) || globHoldsNoData(abs);
}

/** What the command runs before a delete is checked against: the target, or
 *  for a glob the folder it matches in. */
const prefixTarget = (abs: string) => (GLOB.test(basename(abs)) ? dirname(abs) : abs);

/**
 * True when `command` opens with recursive deletes of disposable targets only
 * and nothing else trips the floor (`trips`). `command` is the text the floor
 * scanned (inert literals already blanked).
 *
 * The disk is read BEFORE the command runs, so what runs before a delete must
 * not be able to put data at its target (delete-prefix.ts `priorRunsLeave`):
 * `mv client-data node_modules/ && rm -rf node_modules` would move client work
 * into a folder this proves disposable, while `tar xzf cc.tgz && rm -rf
 * CompCert` in /tmp extracts copies (TB2 compile-compcert, 2026-10-28). What
 * follows a delete (`&& npm install`) runs after it and changes nothing it
 * hits. A single `|` or `&` runs its sides at once, so a delete joined by one
 * is never proven (`rm -rf node_modules & mv client-data node_modules`). Each
 * delete's folder is the one its `cd`s place it in (shellDeletes), including a
 * cd proven not to fail (`cdCannotFail`).
 */
export function isDisposableTreeDelete(command: string, trips: (segment: string) => boolean, scope: TreeDeleteScope): boolean {
  const line = deleteLine(command);
  if (line === null) return false;
  const cwds = new Map(shellDeletes(line, scope.cwd, cdCannotFail(line)).map((d) => [d.segment, d.cwd]));
  let found = false;
  for (const [i, seg] of shellSegments(line).entries()) {
    const part = seg.text.trim();
    if (!part || !trips(part)) continue;
    const del = treeDeleteOf(part);
    const cwd = cwds.get(i);
    if (!del || typeof cwd !== "string" || !runsAlone(line, i)) return false;
    const at = { ...scope, cwd };
    if (!del.targets.every((t) => disposable(t, del.verb, at) && priorRunsLeave(line, i, prefixTarget(resolve(cwd, t))))) return false;
    found = true;
  }
  return found;
}

const GLOB = /[*?[]/;

/** One single-file delete target that is nobody's data: in the real temp
 *  dir, not there at all, or holding no data (no-data-paths.ts: a link, a
 *  socket, a pid file, a system cache, an object file beside its source). A
 *  glob counts only in the last segment, under a temp folder or where every
 *  match holds no data. */
function disposableFile(target: string, cwd: string | undefined, tempDir: string): boolean {
  if (!target || unplaceable(target) || (cwd === undefined && !isAbsolute(target))) return false;
  const abs = resolve(cwd ?? "", target);
  if (GLOB.test(dirname(abs))) return false;
  if (GLOB.test(basename(abs))) return globFolderAbsent(abs) || inTempDir(join(dirname(abs), "_"), tempDir) || globHoldsNoData(abs);
  let stat;
  try { stat = lstatSync(abs); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
  return inTempDir(abs, tempDir) || holdsNoData(abs, stat, /[\\/]$/.test(target));
}

/**
 * The targets, as written, of the plain single-file deletes in `command` that
 * are nobody's data (`disposableFile`), for the un-named-delete gate, by the
 * order rule isDisposableTreeDelete applies. TB2 2026-10-24 refused `rm -f
 * /tmp/launch.zip`, `cd /tmp && rm -f t.db`, and `rm -f cparser/Parser*.ml` in
 * a build folder under /tmp, as user files; 2026-10-28, `rm
 * /etc/nginx/sites-enabled/default` (a link) and `cd /tmp && ccomp -o cc_test2
 * cc_test.c && ./cc_test2; rm -f cc_test2`. With no `cwd` (the caller does not
 * know where the shell runs), a relative target counts only after a `cd` to an
 * absolute folder.
 */
export function disposableFileDeletes(command: string, scope: { cwd?: string; tempDir?: string }): string[] {
  const line = deleteLine(command);
  if (line === null) return [];
  const segments = shellSegments(line);
  const out: string[] = [];
  for (const del of shellDeletes(line, scope.cwd, cdCannotFail(line))) {
    if (del.wrapped || del.recursive || del.opaque || del.cwd === null) continue;
    if (!plainDelete(segments[del.segment].text) || !runsAlone(line, del.segment)) continue;
    for (const t of del.targets) {
      if (out.includes(t) || !disposableFile(t, del.cwd, scope.tempDir ?? tmpdir())) continue;
      if (priorRunsLeave(line, del.segment, prefixTarget(resolve(del.cwd ?? "", t)))) out.push(t);
    }
  }
  return out;
}
