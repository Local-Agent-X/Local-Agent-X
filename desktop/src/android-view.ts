/**
 * Android device mirror — renderer-side canvas frame sink, NOT a native
 * child view. Unlike browser-views.ts (a WebContentsView the OS composites),
 * there is no Android rendering surface to attach: the server child polls
 * `adb exec-out screencap` (src/android/frame-stream.ts) and pushes PNG bytes
 * up through the existing server<->main message channel; this module's only
 * job is relaying those bytes to the renderer, which draws them into a
 * `<canvas>` (see public/js/android-view-client.js). No bounds-negotiation
 * dance is needed because there is no OS-level view to paint out of turn.
 */

import { getMainWindow } from "./window";

export interface AndroidFrameMessage {
	type: "lax:android-frame";
	viewId: string;
	/** base64-encoded PNG, one full frame. */
	pngBase64: string;
}

export function isAndroidFrameMessage(msg: unknown): msg is AndroidFrameMessage {
	return !!msg && typeof msg === "object" && (msg as { type?: unknown }).type === "lax:android-frame";
}

export function handleAndroidFrameMessage(msg: AndroidFrameMessage): void {
	const win = getMainWindow();
	if (!win || win.isDestroyed()) return;
	win.webContents.send("android-frame", { viewId: msg.viewId, pngBase64: msg.pngBase64 });
}
