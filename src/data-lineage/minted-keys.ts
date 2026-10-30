/**
 * Data Lineage — key files a session's own commands MADE.
 *
 * The sensitive-path classifier (paths.ts) judges a file by its name: a
 * `server.key` or `server.pem` is a credential, so a command that reads one
 * has its whole output withheld (tool-execution/sensitive-read-taint.ts). A
 * key the agent generated a moment ago with `openssl genpkey -out
 * /app/ssl/server.key` is not the user's secret, though: its bytes came from
 * the agent's own command, and withholding `ls -la /app/ssl/` because it names
 * that key left the agent unable to check its own work (TB2
 * openssl-selfsigned-cert, 2026-10-24 and 2026-10-29).
 *
 * A path lands here only when a command named it, it did not exist before the
 * command ran and does after, and the command read no other sensitive file
 * that existed (so `cp ~/.ssh/id_rsa /tmp/x.key` makes nothing). Once here, a
 * later command naming it is not withheld; its output still passes the
 * delivery-point masking, which hides a private-key block wherever it appears.
 *
 * Its own registry, not task-artifacts.ts: an artifact there is also a file
 * the shell delete guard protects, which is not this axis. In-memory and
 * sticky for the session's life, like the other lineage registries. Not
 * propagated to a parent session: a parent that does not know a key was made
 * withholds it, which is the old behavior.
 */

import { resolve } from "node:path";
import { realpathDeep } from "../workspace/paths.js";

/** sessionId → canonical absolute paths of key files its commands made. */
const sessionKeys = new Map<string, Set<string>>();

function canonical(path: string): string {
	try {
		return realpathDeep(resolve(path));
	} catch {
		return resolve(path);
	}
}

export function recordMintedKey(sessionId: string, path: string): void {
	if (!sessionId || !path) return;
	let set = sessionKeys.get(sessionId);
	if (!set) {
		set = new Set();
		sessionKeys.set(sessionId, set);
	}
	set.add(canonical(path));
}

/** Did a command of this session make this key file? */
export function isMintedKey(sessionId: string, path: string): boolean {
	if (!sessionId || !path) return false;
	return sessionKeys.get(sessionId)?.has(canonical(path)) ?? false;
}

/** Tests only: forget a session's keys. */
export function clearMintedKeys(sessionId: string): void {
	sessionKeys.delete(sessionId);
}
