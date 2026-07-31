/**
 * browser-partition-permissions — the human-consent layer for in-app browser
 * partitions.
 *
 * Split out of browser-partition.ts (which owns network hardening: egress,
 * download quarantine, perception). Permission grants are a different concern
 * from request filtering: they are answered by the USER through a native modal,
 * never by the agent, and they carry their own per-partition memory.
 *
 * Behaviour preserved exactly from the original inline implementation:
 *   - Clipboard writes are silently allowed (harmless, no modal).
 *   - Passive/noisy capabilities (sensors, notifications, idle detection, midi)
 *     are silently DENIED — denying them without interrupting the user.
 *   - Everything meaningful (camera, microphone, geolocation, …) prompts, and
 *     the answer is remembered per (origin, permission) for the app's lifetime,
 *     which is how a normal browser behaves.
 *   - Simultaneous requests for the SAME (origin, permission) are COALESCED:
 *     one modal, every pending callback settled with its answer. Without this a
 *     page can queue several identical dialogs before the first is answered.
 */
import { dialog, type Session, type WebContents } from "electron";

/** Harmless enough to grant without a modal. */
export const SILENT_SAFE_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

/** Denied without a modal — passive/noisy, and never worth interrupting for. */
export const SILENT_DENIED_PERMISSIONS = new Set([
	"sensors",
	"notifications",
	"idle-detection",
	"idleDetection",
	"midi",
	"midiSysex",
]);

/** Origin for the prompt text. Pure — unparseable URLs degrade to a marker
 *  rather than throwing inside a permission handler. */
export function permissionOrigin(url: string): string {
	try { return new URL(url).origin; } catch { return "unknown-origin"; }
}

/** Asks the human. Injectable so tests never open a native modal. */
export type PermissionPrompt = (origin: string, permission: string) => Promise<boolean>;

const nativePrompt: PermissionPrompt = (origin, permission) =>
	dialog.showMessageBox({
		type: "question",
		title: "Website permission",
		message: `${origin} wants permission to use ${permission}.`,
		detail: "Allow only if you expect this request. The agent cannot approve it for you.",
		buttons: ["Block", "Allow"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	}).then(
		(result) => result.response === 1,
		() => false,
	);

/**
 * Install the check + request handlers on a partition session. One call per
 * partition; the decision memory is per-installation (per partition), matching
 * the original inline closures.
 */
export function installPermissionHandlers(sess: Session, prompt: PermissionPrompt = nativePrompt): void {
	const decisions = new Map<string, boolean>();
	const pending = new Map<string, Array<(granted: boolean) => void>>();

	sess.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
		if (SILENT_SAFE_PERMISSIONS.has(permission)) return true;
		if (SILENT_DENIED_PERMISSIONS.has(permission)) return false;
		const origin = permissionOrigin(details.requestingUrl || requestingOrigin);
		return decisions.get(`${origin}|${permission}`) === true;
	});

	sess.setPermissionRequestHandler(
		(wc: WebContents | null, permission: string, callback: (granted: boolean) => void, details) => {
			if (SILENT_SAFE_PERMISSIONS.has(permission)) {
				callback(true);
				return;
			}
			if (SILENT_DENIED_PERMISSIONS.has(permission)) {
				callback(false);
				return;
			}
			const requestingUrl = details.requestingUrl || (wc && !wc.isDestroyed() ? wc.getURL() : "");
			const key = `${permissionOrigin(requestingUrl)}|${permission}`;
			const remembered = decisions.get(key);
			if (remembered !== undefined) {
				callback(remembered);
				return;
			}
			const queued = pending.get(key);
			if (queued) {
				queued.push(callback);
				return;
			}
			pending.set(key, [callback]);
			void prompt(permissionOrigin(requestingUrl), permission).then((granted) => {
				decisions.set(key, granted);
				const callbacks = pending.get(key) ?? [];
				pending.delete(key);
				for (const settle of callbacks) settle(granted);
			});
		},
	);
}
