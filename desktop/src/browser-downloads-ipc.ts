/**
 * Renderer IPC for the pane's Downloads panel (browser-downloads-panel.js).
 * Lists the USER download registry plus a read-only view of agent-quarantined
 * entries (so a download that "went nowhere" is explained on the spot), and
 * services open / show-in-folder for USER entries only — ids resolve through
 * the user registry, so a quarantine .part can never be opened or revealed
 * from here (release stays behind the agent approval flow).
 */
import { shell, ipcMain, type IpcMainInvokeEvent } from "electron";

import { isTrustedBrowserSender } from "./browser-page-controls";
import { listQuarantinedDownloads } from "./browser-partition";
import { listUserDownloads, userDownloadPath } from "./browser-user-download-registry";

export function setupBrowserDownloadsIPC(): void {
	ipcMain.handle("browser-downloads-list", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		return {
			user: listUserDownloads(),
			// Read-only awareness of the agent's quarantine — filename/state/size
			// only, never the quarantine path.
			quarantined: listQuarantinedDownloads().map((q) => ({
				id: q.id, filename: q.filename, state: q.state, bytes: q.bytes, url: q.url,
			})),
		};
	});

	ipcMain.handle("browser-download-open", async (event: IpcMainInvokeEvent, id: string) => {
		if (!isTrustedBrowserSender(event.sender)) return false;
		const path = userDownloadPath(String(id));
		if (!path) return false;
		return (await shell.openPath(path)) === "";
	});

	ipcMain.handle("browser-download-reveal", (event: IpcMainInvokeEvent, id: string) => {
		if (!isTrustedBrowserSender(event.sender)) return false;
		const path = userDownloadPath(String(id));
		if (!path) return false;
		shell.showItemInFolder(path);
		return true;
	});
}
