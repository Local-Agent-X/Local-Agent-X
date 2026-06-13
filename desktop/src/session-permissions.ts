import { join } from "path";
import { session, shell, type WebContents, type DownloadItem } from "electron";

import { getLAXConfig } from "./config";

const ALLOWED_PERMISSIONS = new Set([
  "media",
  "mediaKeySystem",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

export function setupSessionPermissions(): void {
  const APP_ORIGIN = `http://127.0.0.1:${getLAXConfig().port}`;

  // Auto-open downloaded document files instead of just saving them.
  session.defaultSession.on("will-download", (_event: unknown, item: DownloadItem) => {
    const filename = item.getFilename();
    const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;
    if (!DOC_EXTENSIONS.test(filename)) return;
    const savePath = join(require("os").tmpdir(), filename);
    item.setSavePath(savePath);
    item.once("done", (_e: unknown, state: string) => {
      if (state === "completed") {
        console.log(`[desktop] Opening downloaded file: ${savePath}`);
        shell.openPath(savePath);
      }
    });
  });

  session.defaultSession.setPermissionRequestHandler(
    (webContents: WebContents, permission: string, callback: (granted: boolean) => void) => {
      const requestOrigin = webContents?.getURL?.() || "";
      if (requestOrigin.startsWith(APP_ORIGIN) && ALLOWED_PERMISSIONS.has(permission)) {
        callback(true);
      } else {
        console.warn(`[desktop] Denied permission "${permission}" for ${requestOrigin}`);
        callback(false);
      }
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc: unknown, permission: string, requestingOrigin: string) =>
      requestingOrigin.startsWith(APP_ORIGIN) && ALLOWED_PERMISSIONS.has(permission),
  );
}
