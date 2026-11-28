// Every guard that compares paths, held to every other name one file answers
// to. Each of these guards was once walked around by a spelling it judged as
// typed (an 8.3 short name, a trailing dot, a stream suffix), one guard and one
// spelling at a time. They all read onDiskPath now; this table is what keeps a
// new guard, or a new spelling, from being checked against only some of them.
//
// Not here: the shell approval tier (tool-execution/shell-approval-tier.ts),
// which reads a command line and has no file to ask about. It treats any short
// name, stream suffix or trailing dot as sensitive, and its own test holds it
// to that.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformRoot } from "../../platform-root.js";
import { resolveIngestRoot } from "../../routes/memory-ingest-root.js";
import { unsafeWorkspaceReason } from "../../workspace/workspace-location.js";
import { evaluateFileAccess } from "./file-access.js";
import { isProtectedInstallPath } from "./install-root.js";
import { onDiskPath } from "./on-disk-name.js";
import { persistenceLocationJudge } from "./persistence-locations.js";

const WINDOWS = process.platform === "win32";

/** The 8.3 name Windows gave `p`, or "" where the volume keeps none. */
function shortName(p: string): string {
  if (!WINDOWS) return "";
  try {
    const out = execSync(`cmd /c for %I in ("${p}") do @echo %~sI`, { encoding: "utf8" }).trim();
    return out.toLowerCase() === p.toLowerCase() ? "" : out;
  } catch { return ""; }
}

let root: string;
let ws: string;
let lax: string;
let autostart: string;
let madeInHome: string | null = null;
const install = resolve(platformRoot());
const dataDirBefore = process.env.LAX_DATA_DIR;

/** A link to `dir` under another name: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkTo(dir: string, name: string): string {
  const at = join(root, name);
  try { symlinkSync(dir, at, WINDOWS ? "junction" : "dir"); } catch { return ""; }
  return at;
}

interface Spelling { name: string; of: (dir: string, leaf: string) => string }

/**
 * The other names `dir/leaf` answers to. `leaf` is "" when the guarded thing
 * is the folder itself; a spelling that needs a file then returns "", as does
 * one this platform or volume does not have.
 */
const SPELLINGS: Spelling[] = [
  { name: "a link to its folder", of: (dir, leaf) => { const l = linkTo(dir, `link-${Math.random().toString(16).slice(2)}`); return l && join(l, leaf); } },
  { name: "forward slashes", of: (dir, leaf) => join(dir, leaf).replace(/\\/g, "/") },
  { name: "another casing", of: (dir, leaf) => (WINDOWS ? join(dirname(dir), basename(dir).toUpperCase(), leaf.toUpperCase()) : "") },
  { name: "an 8.3 short name", of: (dir, leaf) => { const s = shortName(dir); return s && join(s, leaf); } },
  { name: "a dot after its folder", of: (dir, leaf) => (WINDOWS ? join(`${dir}.`, leaf) : "") },
  { name: "a space after its folder", of: (dir, leaf) => (WINDOWS ? join(`${dir} `, leaf) : "") },
  { name: "a stream suffix on its folder", of: (dir, leaf) => (WINDOWS ? join(`${dir}::$INDEX_ALLOCATION`, leaf) : "") },
  { name: "a dot after the file", of: (dir, leaf) => (WINDOWS && leaf ? join(dir, `${leaf}.`) : "") },
  { name: "a stream suffix on the file", of: (dir, leaf) => (WINDOWS && leaf ? join(dir, `${leaf}::$DATA`) : "") },
];

interface Guard {
  name: string;
  /** The guarded folder (or the folder holding the guarded file) and the file in it, "" for the folder itself. */
  target: () => { dir: string; leaf: string };
  refuses: (path: string) => boolean;
  /** A path of the same shape that the guard lets through. */
  open: () => string;
}

const read = (p: string): boolean => evaluateFileAccess(ws, "unrestricted", () => false, "read", p, undefined).allowed;
const write = (p: string): boolean => evaluateFileAccess(ws, "unrestricted", () => false, "write", p, undefined).allowed;

const GUARDS: Guard[] = [
  { name: "a credential file is not read", target: () => ({ dir: join(root, ".aws"), leaf: "credentials" }),
    refuses: (p) => !read(p), open: () => join(root, "plain", "notes.txt") },
  { name: "a security switch in the data dir is not written", target: () => ({ dir: lax, leaf: "security.json" }),
    refuses: (p) => !write(p), open: () => join(root, "plain", "notes.txt") },
  { name: "the install folder is protected", target: () => ({ dir: install, leaf: "package.json" }),
    refuses: (p) => isProtectedInstallPath(p), open: () => join(root, "plain", "package.json") },
  { name: "a file that runs at login is a persistence location", target: () => ({ dir: autostart, leaf: "planted.desktop" }),
    refuses: (p) => persistenceLocationJudge()(p) !== null, open: () => join(root, "plain", "planted.desktop") },
  { name: "a folder of credentials is not read into memory", target: () => ({ dir: join(root, ".aws"), leaf: "" }),
    refuses: (p) => "refused" in resolveIngestRoot(p), open: () => join(root, "plain") },
  { name: "the data dir is not read into memory", target: () => ({ dir: lax, leaf: "" }),
    refuses: (p) => "refused" in resolveIngestRoot(p), open: () => join(root, "plain") },
  { name: "a workspace inside the install folder is unsafe", target: () => ({ dir: join(install, "src"), leaf: "" }),
    refuses: (p) => unsafeWorkspaceReason(p, install) !== null, open: () => join(root, "plain") },
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lax-on-disk-guards-"));
  ws = join(root, "ws");
  lax = join(root, "laxdata");
  for (const dir of [ws, lax, join(root, ".aws"), join(root, "plain")]) mkdirSync(dir);
  writeFileSync(join(root, ".aws", "credentials"), "[default]");
  writeFileSync(join(root, "plain", "notes.txt"), "plain");
  writeFileSync(join(lax, "security.json"), "{}");
  process.env.LAX_DATA_DIR = lax;
  // The test env's HOME is a throwaway dir. Only what this file creates in it is removed.
  autostart = join(homedir(), ".config", "autostart");
  madeInHome = mkdirSync(autostart, { recursive: true }) ?? null;
});
afterAll(() => {
  if (dataDirBefore === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = dataDirBefore;
  rmSync(root, { recursive: true, force: true });
  if (madeInHome) rmSync(madeInHome, { recursive: true, force: true });
});

describe.each(GUARDS)("$name", (guard) => {
  it("by its own name, and a path beside it is let through", () => {
    const { dir, leaf } = guard.target();
    expect(guard.refuses(join(dir, leaf))).toBe(true);
    expect(guard.refuses(guard.open())).toBe(false);
  });

  it.each(SPELLINGS)("reached by $name", (spelling) => {
    const { dir, leaf } = guard.target();
    const path = spelling.of(dir, leaf);
    if (!path) return; // this platform or volume has no such name, or the guard has no file
    expect(guard.refuses(path), path).toBe(true);
  });
});

describe("onDiskPath", () => {
  it("names the folder that exists and keeps a new file's name as typed", () => {
    const named = onDiskPath(join(root, "plain", "not-yet.txt"));
    expect(named).toBe(join(onDiskPath(join(root, "plain")), "not-yet.txt"));
  });

  it("gives every spelling of a folder the same name", () => {
    const dir = join(root, ".aws");
    const names = SPELLINGS.map((s) => s.of(dir, "")).filter(Boolean).map(onDiskPath);
    expect(new Set(names)).toEqual(new Set([onDiskPath(dir)]));
  });

  it("does not throw on a symlink cycle or a drive that is not there: such a path reaches nothing", () => {
    const a = join(root, "cycle-a");
    const b = join(root, "cycle-b");
    let cycle = true;
    try { symlinkSync(b, a, WINDOWS ? "junction" : "dir"); symlinkSync(a, b, WINDOWS ? "junction" : "dir"); } catch { cycle = false; }
    if (cycle) expect(() => onDiskPath(join(a, "x"))).not.toThrow();
    const absent = WINDOWS ? "Q:\\not\\there.txt" : "/no-such-root-dir/not/there.txt";
    expect(onDiskPath(absent)).toBe(resolve(absent));
  });
});
