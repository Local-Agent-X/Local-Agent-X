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

import { homedir } from "node:os";
import { basename, join } from "node:path";
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

/** The home-relative locations the macOS and Linux shell cages deny writes to. */
export function cagePersistenceLocations(): { files: string[]; dirs: string[] } {
  const inHome = PERSISTENCE_LOCATIONS.filter((l) => l.base === "home");
  return {
    files: inHome.filter((l) => l.kind === "file").map((l) => l.rel),
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
  return (p) => {
    const target = onDiskSpelling(p);
    const key = comparable(target);
    const hit = named.find(({ loc, at }) => (loc.kind === "file" ? key === at : pathIsWithin(at, key)));
    return hit ? { path: target, runs: hit.loc.runs } : null;
  };
}
