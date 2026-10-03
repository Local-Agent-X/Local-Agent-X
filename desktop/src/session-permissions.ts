import { join } from "path";
import { session, shell, type WebContents, type DownloadItem } from "electron";

import { isAppOrigin } from "./app-window-guards";
import { permissionOrigin } from "./browser-partition-permissions";
import { getMainWindow } from "./window";

// Microphone, clipboard reads and notifications are meant for the app shell.
// The account window shares its origin, so the origin cannot tell them apart:
// the shell is identified as the main window's top frame instead. Agent-built
// pages (/apps/, /files/) are served from the server's agent origin, another
// loopback port, and the shell frames them sandboxed, so a page cannot reach
// the shell's own permissions through `parent` either.
const SHELL_PERMISSIONS = new Set(["media", "mediaKeySystem", "notifications", "clipboard-read"]);

// A copy button on any of our pages; the in-app browser grants it to every site.
const APP_ORIGIN_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

function isMainWindow(webContents: WebContents | null): boolean {
  const main = getMainWindow();
  return main != null && !main.isDestroyed() && webContents === main.webContents;
}

// The shell frames agent-built apps (#pin-iframe, the IDE preview) from the
// agent origin, a loopback port the desktop is not told, and an app's copy
// button needs the clipboard write every site gets in the in-app browser.
function isLoopbackFrameInShell(webContents: WebContents | null, frame: { isMainFrame: boolean; url: string }): boolean {
  if (frame.isMainFrame) return false;
  let parsed: URL;
  try { parsed = new URL(frame.url); } catch { return false; }
  return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && isMainWindow(webContents);
}

function isPermissionGranted(
  webContents: WebContents | null,
  permission: string,
  frame: { isMainFrame: boolean; url: string },
): boolean {
  if (APP_ORIGIN_PERMISSIONS.has(permission) && isLoopbackFrameInShell(webContents, frame)) return true;
  if (!isAppOrigin(frame.url)) return false;
  if (APP_ORIGIN_PERMISSIONS.has(permission)) return true;
  return SHELL_PERMISSIONS.has(permission) && frame.isMainFrame && isMainWindow(webContents);
}

export function setupSessionPermissions(): void {
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

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const frame = { isMainFrame: details.isMainFrame, url: details.requestingUrl };
    if (isPermissionGranted(webContents, permission, frame)) {
      callback(true);
      return;
    }
    // The origin only: the shell's URL carries the operator token.
    const where = `${permissionOrigin(details.requestingUrl)}${details.isMainFrame ? "" : " (subframe)"}`;
    console.warn(`[desktop] Denied permission "${permission}" for ${where}`);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    isPermissionGranted(webContents, permission, { isMainFrame: details.isMainFrame, url: requestingOrigin }),
  );
}
