/**
 * The pane's permission bar (public/js/browser-permission-bar.js), main side.
 *
 * A quietly blocked request (QUIET_BLOCKED_PERMISSIONS in
 * browser-partition-permissions.ts) from a pane tab is pushed to the renderer
 * as "browser-permission-blocked", tagged with the tab's viewId, instead of
 * opening a modal. The bar's Allow comes back as "browser-permission-allow":
 * the grant goes into the partition's one decision memory (allowPermission)
 * and the tab reloads so the page can ask again and get it.
 *
 * Allow grants only what this bar blocked: a renderer message cannot use it to
 * grant a camera or a location, which keep their modal.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import { isTrustedBrowserSender } from "./browser-page-controls";
import { getHardenedPartitionSession } from "./browser-partition";
import { allowPermission, QUIET_BLOCKED_PERMISSIONS, setQuietBlockSink, type QuietBlock } from "./browser-partition-permissions";
import { getBrowserView, listBrowserViews, viewIdForWebContents } from "./browser-views";
import { getMainWindow } from "./window";

/** The renderer's copy of a quiet block: which tab it belongs to, and the
 *  sentence the bar shows (worded main-side with the modal's text). */
export interface PermissionBarNotice extends QuietBlock {
	viewId: string;
}

/** Push a block to the pane. False — so the modal asks instead — when the
 *  webContents is no pane tab (a popup) or the window is gone. */
export function notifyPaneOfQuietBlock(wc: WebContents, block: QuietBlock): boolean {
	const viewId = viewIdForWebContents(wc.id);
	const win = getMainWindow();
	if (!viewId || !win || win.isDestroyed()) return false;
	const notice: PermissionBarNotice = { viewId, ...block };
	win.webContents.send("browser-permission-blocked", notice);
	return true;
}

export function setupBrowserPermissionBarIPC(): void {
	setQuietBlockSink(notifyPaneOfQuietBlock);

	ipcMain.handle(
		"browser-permission-allow",
		(event: IpcMainInvokeEvent, viewId: string, origin: string, permission: string): boolean => {
			if (!isTrustedBrowserSender(event.sender)) return false;
			if (!QUIET_BLOCKED_PERMISSIONS.has(String(permission))) return false;
			const info = listBrowserViews().find((v) => v.viewId === viewId);
			const view = getBrowserView(String(viewId));
			if (!info || !view || view.webContents.isDestroyed()) return false;
			allowPermission(getHardenedPartitionSession(info.partition), String(origin), String(permission));
			view.webContents.reload();
			return true;
		},
	);
}
