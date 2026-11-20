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
 *   - Storage access from a pane tab is blocked QUIETLY: the pane shows a bar
 *     with Allow instead of a modal (QUIET_BLOCKED_PERMISSIONS). A popup, which
 *     has no bar, still gets the modal.
 *   - The modal and the bar say in plain words who asks and what it could do
 *     (describePermissionRequest), never just the raw permission name.
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

/**
 * Blocked without a modal when the request comes from a pane tab: the pane
 * shows a bar with an Allow button instead (setQuietBlockSink). Storage access
 * is an embedded piece of a page (a chat window, a video, a sign-in box) asking
 * to use what it saved in the browser before. Pages ask for it on load, and a
 * modal for it stopped the user on microsoft.com over its chat widget
 * (2026-11-19). Blocking it costs at most a "signed out" embed, which the bar
 * lets the user undo.
 */
export const QUIET_BLOCKED_PERMISSIONS = new Set(["storage-access", "top-level-storage-access"]);

/** What a permission lets a page do, in words, finishing "wants to …". */
const PERMISSION_WORDS: Record<string, string> = {
	geolocation: "see your location",
	"clipboard-read": "read what you copied to your clipboard",
	"deprecated-sync-clipboard-read": "read what you copied to your clipboard",
	"display-capture": "see and record your screen",
	fullscreen: "go full screen",
	pointerLock: "hide and lock your mouse pointer",
	keyboardLock: "take over your keyboard shortcuts",
	openExternal: "open another app on your computer",
	"storage-access": "remember you here, using data it saved in your browser before (for example, to keep you signed in)",
	"top-level-storage-access": "remember you here, using data it saved in your browser before (for example, to keep you signed in)",
	"window-management": "see your screens and place windows on them",
	"speaker-selection": "choose which speaker plays its sound",
	hid: "connect to a device plugged into your computer",
	serial: "connect to a device plugged into your computer",
	usb: "connect to a device plugged into your computer",
	fileSystem: "read or change files on your computer",
	mediaKeySystem: "play protected video",
};

/** The site a URL belongs to, as a person reads it: the host without "www.". */
function siteOf(url: string): string {
	try { return new URL(url).hostname.replace(/^www\./, "") || "an unknown site"; } catch { return "an unknown site"; }
}

function mediaWords(mediaTypes: readonly string[] | undefined): string {
	const camera = !mediaTypes || mediaTypes.includes("video");
	const microphone = !mediaTypes || mediaTypes.includes("audio");
	if (camera && microphone) return "use your camera and microphone";
	return camera ? "use your camera" : "use your microphone";
}

/** One permission request, as the code knows it. */
export interface PermissionAsk {
	permission: string;
	/** The frame that asked: the page itself, or something embedded in it. */
	requestingUrl: string;
	/** The page the user is looking at; empty when unknown. */
	pageUrl: string;
	/** Camera/microphone requests only: which of the two. */
	mediaTypes?: readonly string[];
}

/**
 * The request in plain words: WHO asks (naming the page when an embedded piece
 * of it is the one asking, since that piece's domain means nothing to most
 * people) and WHAT it would be able to do. The raw permission name is the
 * fallback only for one this table does not know.
 */
export function describePermissionRequest(ask: PermissionAsk): { who: string; what: string } {
	const site = siteOf(ask.requestingUrl);
	const page = ask.pageUrl ? siteOf(ask.pageUrl) : site;
	const who = page === site ? site : `Something embedded in ${page} (from ${site})`;
	const what = ask.permission === "media"
		? mediaWords(ask.mediaTypes)
		: PERMISSION_WORDS[ask.permission] ?? `use a browser feature called "${ask.permission}"`;
	return { who, what };
}

/** Asks the human. Injectable so tests never open a native modal. */
export type PermissionPrompt = (origin: string, permission: string, ask: PermissionAsk) => Promise<boolean>;

const nativePrompt: PermissionPrompt = (_origin, _permission, ask) => {
	const { who, what } = describePermissionRequest(ask);
	return dialog.showMessageBox({
		type: "question",
		title: "Website permission",
		message: `${who} wants to ${what}.`,
		detail: "If you didn't expect this, Block is safe: the page keeps working without it. "
			+ "Only you can answer this; the agent can't approve it for you.",
		buttons: ["Block", "Allow"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	}).then(
		(result) => result.response === 1,
		() => false,
	);
};

/** What the pane is told about a quiet block. */
export interface QuietBlock {
	origin: string;
	permission: string;
	/** "{who} wanted to {what}." — the bar's sentence, worded here with the prompt. */
	text: string;
}

/**
 * Where quiet blocks go: browser-ipc wires the pane. Returns false when the
 * webContents is not a pane tab (a popup), which then gets the modal instead,
 * so no request is ever blocked where the user cannot see it.
 */
let quietBlockSink: ((wc: WebContents, block: QuietBlock) => boolean) | null = null;
export function setQuietBlockSink(fn: typeof quietBlockSink): void {
	quietBlockSink = fn;
}

// Each session's decision memory, so the pane's Allow lands in the same map
// the handlers read rather than in a second store.
const decisionsBySession = new WeakMap<Session, Map<string, boolean>>();

/** The user pressed Allow on the pane's bar: remember the grant for this
 *  partition, exactly as a modal "Allow" would. */
export function allowPermission(sess: Session, origin: string, permission: string): void {
	decisionsBySession.get(sess)?.set(`${origin}|${permission}`, true);
}

/** Hand a quiet block to the pane; false when no pane tab can show it. A
 *  throwing sink counts as "not shown", so the modal still asks. */
function quietBlock(wc: WebContents, ask: PermissionAsk): boolean {
	if (!quietBlockSink) return false;
	const { who, what } = describePermissionRequest(ask);
	try {
		return quietBlockSink(wc, {
			origin: permissionOrigin(ask.requestingUrl),
			permission: ask.permission,
			text: `${who} wanted to ${what}.`,
		});
	} catch {
		return false;
	}
}

/**
 * Install the check + request handlers on a partition session. One call per
 * partition; the decision memory is per-installation (per partition), matching
 * the original inline closures.
 */
export function installPermissionHandlers(sess: Session, prompt: PermissionPrompt = nativePrompt): void {
	const decisions = new Map<string, boolean>();
	decisionsBySession.set(sess, decisions);
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
			const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : "";
			const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
			const ask: PermissionAsk = { permission, requestingUrl, pageUrl, mediaTypes };
			if (QUIET_BLOCKED_PERMISSIONS.has(permission) && wc && quietBlock(wc, ask)) {
				// Not remembered: the bar's Allow, or the page asking again on a later
				// visit, must still be able to reach a grant.
				callback(false);
				return;
			}
			const queued = pending.get(key);
			if (queued) {
				queued.push(callback);
				return;
			}
			pending.set(key, [callback]);
			void prompt(permissionOrigin(requestingUrl), permission, ask).then((granted) => {
				decisions.set(key, granted);
				const callbacks = pending.get(key) ?? [];
				pending.delete(key);
				for (const settle of callbacks) settle(granted);
			});
		},
	);
}
