/**
 * Atomic I/O on a VALIDATED canonical inode — the open/read/write half of the
 * file-access gate, kept in its own module so file-access.ts stays one
 * responsibility (the policy decision) under the source-hygiene LOC gate.
 *
 * These helpers close the check-on-string / open-on-inode TOCTOU (R4-19): the
 * pre-dispatch gate (evaluateFileAccess) validates a realpath, then the tool
 * sinks must open THAT exact inode — not re-derive a raw lexical path a symlink
 * swap could repoint. Each helper re-canonicalizes via realpathDeep, re-checks
 * the inode against the sensitive-path rules (matchesSensitivePath), and opens
 * the leaf with O_NOFOLLOW so a symlink swapped in between realpath and open is
 * rejected (ELOOP) rather than followed. Depends only on file-access.ts's
 * classification primitives — one-way, no cycle.
 */
import { openSync, closeSync, lstatSync, readFileSync, writeFileSync, constants } from "node:fs";
import { realpathDeep, matchesSensitivePath } from "./file-access.js";

// fs.constants.O_NOFOLLOW is POSIX-only; on Windows it is undefined and falls
// back to 0 in the flag sets below. There the leaf check is emulated with an
// lstat before open (assertLeafNotSymlink): not atomic like the kernel flag,
// but Windows symlinks (and junctions — lstat reports both as symlinks) are
// still rejected rather than followed. Elevation is NOT required to create
// symlinks on Windows with Developer Mode on, so the emulation is load-bearing,
// not belt-and-suspenders. (O_RDONLY is 0 on every platform, so this OR is the
// read-only flag set with NOFOLLOW added where the platform supports it.)
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

// Windows fallback for the missing O_NOFOLLOW: reject a symlinked leaf before
// open. ENOENT is fine (O_CREAT write of a new file); only an existing
// symlink/junction at the leaf is refused.
function assertLeafNotSymlink(absPath: string): void {
	if (constants.O_NOFOLLOW !== undefined) return; // kernel flag handles it
	try {
		if (lstatSync(absPath).isSymbolicLink()) {
			throw new Error(`Blocked: refusing to open symlinked leaf ${absPath} (no O_NOFOLLOW on this platform)`);
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		throw e;
	}
}

/**
 * Open the VALIDATED canonical inode for a READ sink, atomically closing the
 * check-on-string / open-on-inode TOCTOU (R4-19). Mirrors the email tool's
 * canonicalizeAttachmentPath pattern (re-canonicalize so the checked inode is
 * the read inode), and hardens it the way checkAttachmentPaths could not: the
 * leaf is opened with O_NOFOLLOW, so a symlink swapped in at the canonical leaf
 * BETWEEN realpath and open is rejected (ELOOP) rather than followed.
 *
 * Steps:
 *   1. realpathDeep(absPath) — follow every existing symlink/junction segment,
 *      exactly as the pre-dispatch gate did, so we bind to the same inode.
 *   2. Re-check that inode against SENSITIVE_PATTERNS. The gate already ran the
 *      mode/containment check on this realpath; re-running the inode-bound
 *      sensitivity check here means a leaf repointed at ~/.ssh/id_rsa after the
 *      gate is caught at open time. (Mode/containment is NOT re-evaluated here:
 *      the active mode + worktree allowlist are SecurityLayer instance state not
 *      available at the sink, and re-deriving them would risk false-blocking a
 *      legitimate worktree read; the sensitivity rules are mode-independent and
 *      are the leg that actually defeats the id_rsa swap.)
 *   3. openSync(realPath, O_RDONLY | O_NOFOLLOW). If the leaf is now a symlink,
 *      the kernel rejects the open with ELOOP — fail closed.
 *
 * Returns the open fd plus the canonical path so the caller can fstat/read the
 * exact inode it just validated. The caller MUST close the fd. A genuine open
 * error (ENOENT, EACCES, ELOOP, …) is surfaced, never swallowed.
 */
export function openValidatedRead(absPath: string): { fd: number; canonicalPath: string } {
	let canonicalPath: string;
	try {
		canonicalPath = realpathDeep(absPath);
	} catch (e) {
		// ELOOP = symlink cycle (attack). realpathDeep only rethrows this.
		if ((e as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error("Blocked: symlink loop detected (possible attack)");
		}
		throw e;
	}

	const normalized = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
	const match = matchesSensitivePath(normalized);
	if (match) {
		throw new Error(`Blocked: matches sensitive path pattern ${typeof match === "string" ? match : match.source}`);
	}

	// O_NOFOLLOW on the leaf: a symlink swapped in at canonicalPath between the
	// realpath above and this open is rejected (ELOOP) rather than followed.
	assertLeafNotSymlink(canonicalPath);
	const fd = openSync(canonicalPath, READ_NOFOLLOW_FLAGS);
	return { fd, canonicalPath };
}

/**
 * Convenience wrapper over {@link openValidatedRead} for sinks that just want
 * the bytes: opens the validated canonical inode with O_NOFOLLOW, reads it
 * fully, and closes the fd. Preserves the caller's own size caps / encoding —
 * it returns a raw Buffer and never swallows an open or read error.
 */
export function readValidatedFile(absPath: string): Buffer {
	const { fd } = openValidatedRead(absPath);
	try {
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

// O_WRONLY | O_CREAT | O_TRUNC, plus O_NOFOLLOW where the platform supports it
// (POSIX-only; undefined on Windows → 0, same fallback as the read flags). The
// NOFOLLOW makes the kernel REJECT the open (ELOOP) if the final path component
// is a symlink, so a pre-planted symlink at the write target can't redirect the
// write to overwrite a file OUTSIDE the workspace (R4-19 write leg). NOFOLLOW
// only guards the LEAF; the parent chain is resolved normally, which is fine —
// the pre-dispatch gate already realpath-confined the whole path.
const WRITE_NOFOLLOW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

/**
 * Write `data` to `absPath` with O_NOFOLLOW on the leaf, atomically closing the
 * symlink-redirect leg of R4-19 for write sinks. Mirrors {@link openValidatedRead}:
 * the caller has already path-confined `absPath` through the pre-dispatch gate;
 * this opens the target itself (not via the high-level writeFileSync(path)) so a
 * symlink swapped in at the leaf is rejected (ELOOP) rather than followed off-box.
 *
 * The parent directory is expected to exist (callers mkdir -p first). A genuine
 * open/write error (ELOOP for a symlinked target, EACCES, …) is surfaced, never
 * swallowed. The caller-supplied `mode` is the create mode for a new file.
 */
export function writeValidatedFile(absPath: string, data: string | Buffer, mode = 0o644): void {
	assertLeafNotSymlink(absPath);
	const fd = openSync(absPath, WRITE_NOFOLLOW_FLAGS, mode);
	try {
		writeFileSync(fd, data);
	} finally {
		closeSync(fd);
	}
}
