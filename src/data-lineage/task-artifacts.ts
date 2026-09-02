/**
 * Data Lineage — per-session TASK-ARTIFACT registry.
 *
 * Sibling of the external-content ingestion registry (external.ts), on a third
 * trust axis: not "did this session touch OUR secrets?" (taint.ts, gates
 * egress) and not "did it ingest UNTRUSTED off-box content?" (external.ts,
 * gates memory auto-promotion), but "which FILES did the agent itself CREATE
 * during this task?". Consumers are the verification-invariants campaign's
 * later chunks: the delete guard ("an agent-created file can't be hard-deleted
 * mid-task") and the verification trigger ("this turn wrote a persistent
 * deliverable — verify it landed").
 *
 * Membership is TOOL-CLASS keyed at the delivery point, like external.ts (D8):
 * the runSandboxedPhase hook enrolls the target of a SUCCESSFUL create-class
 * tool call (write / spreadsheet write / document create / pdf create+merge /
 * presentation create+from_outline / create_chart) — and ONLY when the file
 * did not exist pre-execute. An overwrite of a pre-existing user file is the
 * agent EDITING the user's data, not creating its own artifact; enrolling it
 * would let a later delete-guard chunk misclassify user files as disposable
 * agent output, the exact inversion this axis exists to prevent.
 *
 * Paths are stored realpathDeep-canonicalized (workspace/paths.ts — the same
 * symlink-resolving canonicalizer the security layer's allow-set and gates
 * use), and queries canonicalize the same way, so a symlinked spelling of a
 * recorded file (macOS /tmp → /private/tmp, junctioned workspaces) can never
 * split one inode into two identities across the record/query seam. String
 * canonicalization alone still misses CASE-variant spellings on
 * case-insensitive volumes (macOS/Windows defaults — realpathSync preserves
 * the query's casing), so isTaskArtifact falls back to inode ground truth on
 * a miss: stat the query and compare (dev, ino) against the session's stored
 * paths. Same inode on any volume matches; different files never do.
 *
 * Lifecycle mirrors external.ts: in-memory, STICKY for the session's life (no
 * production caller clears it — clearTaskArtifacts exists for tests, like
 * clearExternalIngestion), propagated parent←child alongside propagateTaint /
 * propagateExternalIngestion (handler-completion.ts): a sub-agent's created
 * deliverables belong to the parent's task once the sub-agent completes.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { realpathDeep } from "../workspace/paths.js";

/** sessionId → realpathDeep-canonical absolute paths the agent created. */
const sessionArtifacts = new Map<string, Set<string>>();

/** Canonicalize one spelling of a path for membership identity. realpathDeep
 *  resolves every existing symlink segment and passes non-existent tails
 *  through lexically; it only rethrows ELOOP (symlink cycle — attack posture,
 *  security/layer treats it the same), for which the lexical resolve is the
 *  safe identity: a cycle can't BE a recorded artifact. */
function canonical(path: string): string {
	try {
		return realpathDeep(resolve(path));
	} catch {
		return resolve(path);
	}
}

/** Enroll a file the agent itself CREATED (did not exist pre-execute) via a
 *  successful create-class tool call. Caller passes the resolved absolute
 *  target; canonicalized again here so membership never depends on which
 *  spelling the recording site held. */
export function recordTaskArtifact(sessionId: string, realpath: string): void {
	if (!sessionId || !realpath) return;
	let set = sessionArtifacts.get(sessionId);
	if (!set) {
		set = new Set();
		sessionArtifacts.set(sessionId, set);
	}
	set.add(canonical(realpath));
}

/** Did this session's agent create this file? The query path is realpath-
 *  normalized, so a symlinked spelling of a recorded artifact still matches;
 *  on a canonical-string miss, inode identity ((dev, ino) of an EXISTING
 *  query target vs the stored paths) catches case-variant spellings on
 *  case-insensitive volumes — a differently-cased rm target must not slip
 *  past the delete guard. Zero false positives: a different file is a
 *  different inode. Best-effort stats — an unstat-able side just doesn't
 *  match. */
export function isTaskArtifact(sessionId: string, path: string): boolean {
	if (!sessionId || !path) return false;
	const set = sessionArtifacts.get(sessionId);
	if (!set || set.size === 0) return false;
	const query = canonical(path);
	if (set.has(query)) return true;
	let q: { dev: number | bigint; ino: number | bigint };
	try {
		q = statSync(query);
	} catch {
		return false; // query target doesn't exist — nothing to identity-match
	}
	for (const stored of set) {
		try {
			const s = statSync(stored);
			if (s.dev === q.dev && s.ino === q.ino) return true;
		} catch { /* stored artifact since deleted/moved — skip */ }
	}
	return false;
}

/** All artifacts recorded for the session (canonical spellings, copy). */
export function listTaskArtifacts(sessionId: string): string[] {
	return [...(sessionArtifacts.get(sessionId) ?? [])];
}

/** Clear the session's registry — test hook, the silent counterpart of
 *  clearExternalIngestion. No production caller: artifacts live exactly as
 *  long as the session. */
export function clearTaskArtifacts(sessionId: string): void {
	sessionArtifacts.delete(sessionId);
}

/**
 * Propagate artifacts from a child (sub-agent) session to its parent,
 * mirroring propagateTaint / propagateExternalIngestion (handler-completion.ts
 * seam): files a sub-agent created are deliverables of the PARENT's task once
 * the completion flows back, so the parent's delete-guard and verification
 * trigger must see them. Returns the number of paths newly added to the
 * parent (for logging / tests). No-op when the child created nothing.
 */
export function propagateTaskArtifacts(childSessionId: string, parentSessionId: string): number {
	if (!childSessionId || !parentSessionId || childSessionId === parentSessionId) return 0;
	const from = sessionArtifacts.get(childSessionId);
	if (!from || from.size === 0) return 0;
	let target = sessionArtifacts.get(parentSessionId);
	if (!target) {
		target = new Set();
		sessionArtifacts.set(parentSessionId, target);
	}
	let added = 0;
	for (const p of from) {
		if (!target.has(p)) {
			target.add(p);
			added++;
		}
	}
	return added;
}
