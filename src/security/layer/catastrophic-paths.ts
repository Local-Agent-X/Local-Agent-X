import { join } from "node:path";

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

/**
 * True when deleting `rawTarget` would break the OS or wipe the user's home —
 * the floor that holds even in unrestricted mode. Handles `~` expansion, a
 * trailing `/`, and a trailing `/*` / `/.` "everything under here" glob (so
 * `rm -rf ~/*` and `rm -rf /*` are caught), then checks the normalized target
 * against the protected roots and the platform's system-dir patterns.
 *
 * A RELATIVE target (`./build`, `dist`) is never catastrophic — it resolves
 * under the project, not at a system root — so only absolute / `~` targets can
 * trip this.
 */
export function isCatastrophicDeleteTarget(
	rawTarget: string,
	home: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const sep = platform === "win32" ? "\\" : "/";
	let t = rawTarget.trim().replace(/^['"]+|['"]+$/g, "");
	if (!t) return false;

	// ~ expansion, exactly as bash does it.
	if (t === "~") t = home;
	else if (t.startsWith("~/") || t.startsWith("~\\")) t = join(home, t.slice(2));

	// Strip a trailing "delete everything under here" glob or slash so
	// `/System/`, `/System/*`, `/System/.` all normalize to `/System`, and
	// `/*` / `~/*` collapse to their root. An empty result means the root `/`.
	t = t.replace(/[\\/](?:\*|\.)?$/, "");
	if (t === "") t = sep;

	// Filesystem root (`/`) or a bare Windows drive root (`C:\`, `D:/`).
	if (t === sep || /^[A-Za-z]:[\\/]?$/.test(t)) return true;

	const norm = platform === "win32" ? t.toLowerCase() : t;

	// Equals a protected root itself.
	for (const r of catastrophicRoots(home, platform)) {
		const rn = platform === "win32" ? r.toLowerCase() : r;
		if (norm === rn) return true;
	}

	// Sits under a shared system directory (re-add a trailing sep so the
	// subpath patterns, which require one, match the bare dir too).
	const probe = t.endsWith(sep) ? t : t + sep;
	for (const p of systemDirPatterns(platform)) if (p.test(probe)) return true;

	return false;
}

/**
 * If `command` is a destructive `rm` (-r/-f) whose target is catastrophic,
 * return a block reason; otherwise null. Called ONLY in unrestricted mode —
 * the workspace/common modes refuse destructive rm outright upstream. Scans
 * each pipe segment whose argv[0] basename is `rm`, gating its non-flag
 * operands through isCatastrophicDeleteTarget.
 */
export function detectCatastrophicRm(
	command: string,
	home: string,
	platform: NodeJS.Platform = process.platform,
): string | null {
	// Split on EVERY command boundary — pipes, ;, &&, ||, &, newlines — not just
	// pipes. On POSIX the upstream separator guard blocks `;` anyway, but on
	// win32 `;` is legit PowerShell statement separation, so `ls; rm -rf /`
	// reached this scan as ONE segment with argv[0]="ls" and the chained rm was
	// invisible (live hole found by the startup self-test's SHL-001).
	for (const segment of command.split(/(?:\|\||&&|[|;&\r\n])+/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		if (!words.length) continue;
		const bin = words[0].replace(/^['"]+|['"]+$/g, "");
		const base = bin.split(/[\\/]/).pop() || bin;
		if (base.toLowerCase() !== "rm") continue;
		for (let i = 1; i < words.length; i++) {
			const w = words[i];
			if (w.startsWith("-")) continue; // a flag (incl. `--`), not a target
			if (isCatastrophicDeleteTarget(w, home, platform)) {
				return `Blocked: refusing to delete a protected system or root path (${w}) even in unrestricted mode — this would break the OS or wipe your home directory. Delete specific files or subfolders instead.`;
			}
		}
	}
	return null;
}
