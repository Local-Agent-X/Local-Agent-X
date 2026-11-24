import { posix, win32 } from "node:path";
import type { DeleteCall } from "./shell-delete-targets.js";

// ── The irreducible "cannot delete, even in unrestricted mode" floor ──
//
// `unrestricted` file-access mode means the agent may read/write/delete the
// user's OWN files anywhere (Downloads, Documents, projects, /tmp). It does NOT
// mean it may `rm -rf /` or wipe the home directory — a single bad glob would
// brick the machine or destroy every personal file. This module is the ONE
// place that answers "is this delete target catastrophic?" so the shell rm
// guard and the unrestricted-write floor agree on what "system directory"
// means and can never drift.
//
// Platform is INJECTED (defaulting to process.platform) rather than read
// inline, so the test suite can pin either branch deterministically on any
// OS — the shell guards branch on platform semantics, and a platform-blind
// test suite is only ever green on the OS it was written on.

const WIN_SYSTEM_DIR_PATTERNS: RegExp[] = [/^[A-Z]:\\Windows\\/i, /^[A-Z]:\\Program Files/i, /^[A-Z]:\\ProgramData\\/i, /^[A-Z]:\\System/i];
const POSIX_SYSTEM_DIR_PATTERNS: RegExp[] = [/^\/etc\//, /^\/sys\//, /^\/proc\//, /^\/boot\//, /^\/usr\/(?:bin|sbin|lib)\//, /^\/sbin\//, /^\/bin\//, /^\/dev\//];

/** System directories whose SUBPATHS are catastrophic, for a given platform. */
export function systemDirPatterns(platform: NodeJS.Platform = process.platform): RegExp[] {
	return platform === "win32" ? WIN_SYSTEM_DIR_PATTERNS : POSIX_SYSTEM_DIR_PATTERNS;
}

// Current-platform constant — the unrestricted-mode WRITE floor
// (file-access.ts) imports this directly; it always wants the running OS.
export const SYSTEM_DIR_PATTERNS: RegExp[] = systemDirPatterns();

// Top-level roots that must never be deleted AS A WHOLE (the dir itself, or a
// `/*` glob of it). Deleting any of these — or the filesystem root or the
// home-directory root — is the "wipe everything" footgun the floor exists for.
// Subpaths UNDER these (e.g. ~/Downloads, /Users/me/projects) are user data and
// stay deletable; only the roots themselves are refused.
function catastrophicRoots(home: string, platform: NodeJS.Platform): string[] {
	if (platform === "win32") {
		return [home, "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData", "C:\\Users"];
	}
	return [
		home,
		"/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt",
		"/dev", "/private", "/boot", "/proc", "/sys", "/cores", "/Network",
		"/Volumes", "/Applications", "/Users", "/home", "/root",
	];
}

/** How much of the floor holds. With `rootsOnly` (a machine its operator
 *  declared disposable, disposable-sandbox.ts) the roots themselves (`/`, home,
 *  /etc, /usr) stay refused, while a file or folder under a system directory
 *  (`/etc/nginx/sites-enabled/default`) is the operator's to remove, as the
 *  unrestricted write floor already allows there. */
export interface DeleteFloor {
	rootsOnly?: boolean;
}

// The spellings of "my home folder" a shell expands before the delete runs.
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|\$env:USERPROFILE|\$\{env:USERPROFILE\}|%USERPROFILE%)(?=$|[\\/])/i;
// A drive as Git Bash, WSL and Cygwin spell it: /c/Users, /mnt/c/Users, /cygdrive/c/Users.
const POSIX_STYLE_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([A-Za-z])(?=$|\/)/;
// Plainly a Windows path wherever it is met: a drive letter or a UNC share.
const WINDOWS_SHAPED = /^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)/;

/** A path in the one form every spelling of it reduces to. `windows` says
 *  which rules read it: `\` separators, and case does not matter. */
interface CanonicalPath { path: string; windows: boolean }

/**
 * The one absolute path `written` names, or null when it is relative. Lexical
 * only: nothing is read from disk. `C:/Users`, `/c/Users` and `C:\Users\` are
 * one folder; `/etc//` and `/./etc` are `/etc`; `/home/me/..` is `/home`; and
 * a trailing `/*` ("everything under here") is the folder itself.
 *
 * Windows rules apply on Windows, and anywhere to a path that is plainly a
 * Windows one, so a Windows home folder is still read right by a caller that
 * pins a POSIX platform (the test suite does, on a Windows machine).
 */
function canonicalPath(written: string, platform: NodeJS.Platform): CanonicalPath | null {
	let t = written;
	// Git Bash runs the shell tool on Windows, so a drive is as often written
	// `/c/Users` or `C:/Users` as `C:\Users`.
	if (platform === "win32") t = t.replace(POSIX_STYLE_DRIVE, (_m, drive: string) => `${drive.toUpperCase()}:`);
	const windows = platform === "win32" || WINDOWS_SHAPED.test(t);
	const paths = windows ? win32 : posix;
	if (windows) {
		t = t.replace(/\//g, "\\");
		if (/^[A-Za-z]:$/.test(t)) t += "\\";
	}
	if (!paths.isAbsolute(t)) return null;
	t = t.replace(/[\\/]\*$/, paths.sep);
	t = paths.normalize(t);
	if (t.length > paths.parse(t).root.length) t = t.replace(/[\\/]+$/, "");
	return { path: t, windows };
}

/** A delete target as typed, with its quotes off and the home folder written
 *  out, in canonical form. Null when it is empty or relative. */
function canonicalDeleteTarget(rawTarget: string, home: string, platform: NodeJS.Platform): CanonicalPath | null {
	let t = rawTarget.trim().replace(/^['"]+|['"]+$/g, "");
	if (!t) return null;
	const homeRef = HOME_PREFIX.exec(t);
	if (homeRef) t = home + t.slice(homeRef[0].length);
	return canonicalPath(t, platform);
}

/**
 * True when deleting `rawTarget` would break the OS or wipe the user's home:
 * the floor that holds even in unrestricted mode. The target is read in
 * canonical form (canonicalPath), so no spelling of a protected folder gets
 * past: the filesystem or a drive root, the home folder or any folder above
 * it, a protected root, or anything under a system directory.
 *
 * A RELATIVE target (`./build`, `dist`) is never catastrophic: it resolves
 * under the project, not at a system root. Only absolute and home-relative
 * targets can trip this.
 */
export function isCatastrophicDeleteTarget(
	rawTarget: string,
	home: string,
	platform: NodeJS.Platform = process.platform,
	floor: DeleteFloor = {},
): boolean {
	const target = canonicalDeleteTarget(rawTarget, home, platform);
	if (target === null) return false;
	const t = target.path;
	const sep = target.windows ? "\\" : "/";
	const key = (p: string): string => (target.windows ? p.toLowerCase() : p);

	// Filesystem root (`/`) or a Windows drive root (`C:\`).
	if (t === sep || /^[A-Za-z]:\\?$/.test(t)) return true;

	// The home folder, or a folder above it: deleting either removes the home.
	const homePath = canonicalPath(home, platform);
	if (homePath && homePath.windows === target.windows) {
		const h = key(homePath.path);
		if (h === key(t) || h.startsWith(key(t) + sep)) return true;
	}

	// Equals a protected root itself.
	for (const r of catastrophicRoots(home, platform)) {
		if (key(t) === key(r)) return true;
	}

	if (floor.rootsOnly) return false;

	// Sits under a shared system directory (the subpath patterns require a
	// trailing separator, so add one to match the bare directory too).
	for (const p of systemDirPatterns(platform)) if (p.test(t + sep)) return true;

	return false;
}

/**
 * If any of `deletes` (the command's, from the one delete extractor,
 * shell-delete-targets.ts) has a catastrophic target, return a block reason;
 * otherwise null. Called ONLY in unrestricted mode — the workspace/common
 * modes refuse a destructive delete they cannot place upstream. Every form
 * counts, behind any wrapper and inside any `bash -c` / `powershell -Command`
 * body: until 2026-10-27 this read only a bare `rm` split on whitespace, so
 * `timeout 60 rm -rf ~`, `Remove-Item -Recurse <home>` and `rd /s /q
 * C:\Users` walked past the floor that holds even here.
 */
export function detectCatastrophicDelete(
	deletes: readonly DeleteCall[],
	home: string,
	platform: NodeJS.Platform = process.platform,
	floor: DeleteFloor = {},
): string | null {
	for (const del of deletes) {
		for (const target of del.targets) {
			if (isCatastrophicDeleteTarget(target, home, platform, floor)) {
				return `Blocked: refusing to delete a protected system or root path (${target}) even in unrestricted mode — this would break the OS or wipe your home directory. Delete specific files or subfolders instead.`;
			}
		}
	}
	return null;
}
