/**
 * Places in the user's own folders that run whatever is written there at the
 * next login, the next terminal or the next git call: outside every cage Local
 * Agent X has, with nothing left to stop it. One list, three consumers:
 *
 *   - the file tools put a write here to the user and refuse it in an
 *     unattended run (tool-execution/control-file-gate.ts). Not a hard block:
 *     "add an alias to my bashrc" is an ordinary request, one click away.
 *   - bulk_replace skips one it finds under the folder it scans
 *     (tools/edit-tools.ts), since that gate sees only the folder.
 *   - the macOS and Linux shell cages deny writes here (sandbox/seatbelt.ts,
 *     sandbox/bwrap.ts), because a shell command has no card to show.
 *
 * ~/.ssh (config with its ProxyCommand, authorized_keys, rc) is not listed:
 * both layers refuse it outright, reads included (file-access.ts
 * SENSITIVE_PATTERNS, sandbox/validate.ts HOME_RELATIVE_DENY_DIRS).
 *
 * `base` is the folder `rel` sits in. Only "home" locations reach the cages:
 * the others are Windows folders, where the cage's sandbox account can write
 * nothing outside the workspace (sandbox/win-cage-grants.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { onDiskSpelling } from "./lax-control-files.js";
import { userContentDirs } from "./file-access.js";
import { pathIsWithin } from "./path-within.js";

export interface PersistenceLocation {
  readonly base: "home" | "documents" | "appData";
  /** "/"-separated, under `base`. */
  readonly rel: string;
  /** "file": that file. "dir": anything inside the folder. */
  readonly kind: "file" | "dir";
  /** What a change there does; finishes "…, which <runs>." on the card. */
  readonly runs: string;
}

const AT_TERMINAL = "runs commands every time you open a terminal or log in";
const AT_LOGIN = "starts programs every time you log in";
const AT_GIT = "can run commands every time git runs";
const AT_POWERSHELL = "runs commands every time PowerShell starts";

function home(kind: "file" | "dir", runs: string, ...rels: string[]): PersistenceLocation[] {
  return rels.map((rel) => ({ base: "home", rel, kind, runs }));
}

export const PERSISTENCE_LOCATIONS: readonly PersistenceLocation[] = [
  // bash and sh (Git Bash reads the same files on Windows), zsh, csh/tcsh, fish.
  ...home("file", AT_TERMINAL, ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile",
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".cshrc", ".tcshrc", ".login", ".config/fish/config.fish"),
  // fish sources every conf.d file at start, and a function file replaces the
  // command it is named after.
  ...home("dir", AT_TERMINAL, ".config/fish/conf.d", ".config/fish/functions"),
  // PowerShell on macOS and Linux.
  ...home("dir", AT_POWERSHELL, ".config/powershell"),
  // X and KDE session scripts, XDG autostart, systemd user units, launchd.
  ...home("file", AT_LOGIN, ".xprofile", ".xinitrc", ".xsession", ".xsessionrc"),
  ...home("dir", AT_LOGIN, ".config/autostart", ".config/autostart-scripts", ".config/plasma-workspace/env",
    ".config/systemd/user", ".local/share/systemd/user", "Library/LaunchAgents", "Library/LaunchDaemons"),
  ...home("dir", "sets environment variables for every program your login session starts", ".config/environment.d"),
  // core.hooksPath, core.fsmonitor, core.sshCommand, aliases starting with "!".
  ...home("file", AT_GIT, ".gitconfig", ".config/git/config"),
  { base: "appData", rel: "Microsoft/Windows/Start Menu/Programs/Startup", kind: "dir", runs: AT_LOGIN },
  // The profiles, and the modules PowerShell loads by command name.
  { base: "documents", rel: "PowerShell", kind: "dir", runs: AT_POWERSHELL },
  { base: "documents", rel: "WindowsPowerShell", kind: "dir", runs: AT_POWERSHELL },
];

const GIT_CONFIGS = [".gitconfig", ".config/git/config"];
const MAX_INCLUDE_DEPTH = 5;

/** The `path` of every [include] / [includeIf …] section in one git config. */
function includePaths(text: string): string[] {
  const out: string[] = [];
  let inInclude = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[([^\]]+)\]/.exec(line);
    if (section) { inInclude = /^include(if\b|$)/i.test(section[1].trim()); continue; }
    const m = inInclude ? /^path\s*=\s*(.+)$/i.exec(line) : null;
    if (m) out.push(m[1].replace(/\s+[#;].*$/, "").replace(/^"(.*)"$/, "$1").trim());
  }
  return out;
}

/**
 * The files the user's git config pulls in with [include] / [includeIf]
 * (~/.gitconfig.local and the like): git runs what they say as surely as
 * ~/.gitconfig, but they have no fixed name, so they are read out of it.
 * Nested includes are followed a few levels; `~/` is the home folder and a
 * relative path is relative to the file that includes it, as git reads them.
 */
export function gitConfigIncludes(userHome: string = homedir()): string[] {
  const found = new Set<string>();
  const visit = (file: string, depth: number): void => {
    if (depth > MAX_INCLUDE_DEPTH || !existsSync(file)) return;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    for (const p of includePaths(text)) {
      const target = p.startsWith("~/") ? join(userHome, p.slice(2)) : isAbsolute(p) ? p : resolve(dirname(file), p);
      if (found.has(target)) continue;
      found.add(target);
      visit(target, depth + 1);
    }
  };
  for (const rel of GIT_CONFIGS) visit(join(userHome, ...rel.split("/")), 0);
  return [...found];
}

/** The home-relative locations the macOS and Linux shell cages deny writes to,
 *  with the files the git config includes from inside the home folder. */
export function cagePersistenceLocations(userHome: string = homedir()): { files: string[]; dirs: string[] } {
  const inHome = PERSISTENCE_LOCATIONS.filter((l) => l.base === "home");
  const included = gitConfigIncludes(userHome)
    .map((p) => relative(userHome, p))
    .filter((rel) => rel && !rel.startsWith("..") && !isAbsolute(rel))
    .map((rel) => rel.split("\\").join("/"));
  return {
    files: [...inHome.filter((l) => l.kind === "file").map((l) => l.rel), ...included],
    dirs: inHome.filter((l) => l.kind === "dir").map((l) => l.rel),
  };
}

export interface PersistenceRoots {
  home: string;
  documents: readonly string[];
  appData: readonly string[];
}

/**
 * Where each base is on this computer. Documents moves into OneDrive when its
 * folder backup is on, and PowerShell follows it there, so every Documents
 * the file-access gate knows counts (userContentDirs reads the same OneDrive
 * roots). APPDATA can be redirected; the default under the profile counts too.
 */
export function persistenceRoots(): PersistenceRoots {
  const userHome = homedir();
  return {
    home: userHome,
    documents: userContentDirs(userHome).filter((d) => basename(d) === "Documents"),
    appData: [...new Set([process.env.APPDATA || join(userHome, "AppData", "Roaming"), join(userHome, "AppData", "Roaming")])],
  };
}

// Windows and macOS volumes answer to any casing, so a write to ~/.BASHRC
// lands on ~/.bashrc there.
function comparable(p: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
}

export type PersistenceLocationOf = (p: string) => { path: string; runs: string } | null;

/**
 * A function naming the persistence location a write to `p` changes, judged
 * by the names the filesystem gives both (a link to ~/.bashrc writes
 * ~/.bashrc), or null. `path` is the file written, as on disk. Every location
 * is named on disk once, here, because that is nearly all the cost and
 * bulk_replace asks about each of up to 2000 files it scans.
 */
export function persistenceLocationJudge(): PersistenceLocationOf {
  const roots = persistenceRoots();
  const named = PERSISTENCE_LOCATIONS.flatMap((loc) => {
    const bases = loc.base === "home" ? [roots.home] : loc.base === "documents" ? roots.documents : roots.appData;
    return bases.map((base) => ({ loc, at: comparable(onDiskSpelling(join(base, ...loc.rel.split("/")))) }));
  });
  for (const file of gitConfigIncludes(roots.home)) {
    named.push({ loc: { base: "home", rel: file, kind: "file", runs: AT_GIT }, at: comparable(onDiskSpelling(file)) });
  }
  return (p) => {
    const target = onDiskSpelling(p);
    const key = comparable(target);
    const hit = named.find(({ loc, at }) => (loc.kind === "file" ? key === at : pathIsWithin(at, key)));
    return hit ? { path: target, runs: hit.loc.runs } : null;
  };
}
