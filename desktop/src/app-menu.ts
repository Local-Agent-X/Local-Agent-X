// Application-menu accelerators for both platforms.
//
// macOS: the custom JS-injected in-window titlebar is skipped on darwin (Mac
// uses the native top-of-screen menu bar), so every app-specific action that
// lives in that titlebar — Restart Server, Show/Hide Agents, Toggle DevTools —
// has to be surfaced here or it's lost. Renderer-targeted items dispatch via
// webContents.executeJavaScript.
//
// Windows/Linux: the visible menu is the in-window titlebar (app.html), but a
// custom titlebar is CLICK-ONLY — Electron registers keyboard accelerators from
// a Menu, and without a Menu there is none. So the same shortcuts that "just
// work" on Mac (Ctrl+R, Ctrl+Shift+A/I, zoom) were dead on Windows. We build a
// HIDDEN accelerator-only menu (autoHideMenuBar keeps the bar invisible) from
// the SAME action set, so both platforms bind identical keys from one source
// and can't drift.

import { app, BrowserWindow, Menu, clipboard, shell } from "electron";
import { restartServer } from "./server-process";
import { getLAXConfig } from "./config";

function tokenizedAppUrl(): string {
  const cfg = getLAXConfig();
  return `http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`;
}

export function setupApplicationMenu(getMainWindow: () => BrowserWindow | null): void {
  const triggerRenderer = (js: string) => {
    getMainWindow()?.webContents.executeJavaScript(js).catch(() => { /* renderer not ready */ });
  };

  // Shared action closures — one definition drives the Mac menu items and the
  // Windows accelerator menu, so a shortcut does the same thing on both.
  const restartServerAction = async () => {
    const { ready, cfg } = await restartServer();
    const win = getMainWindow();
    if (ready && win) win.loadURL(`http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`);
  };
  // Ctrl+R: NOT a raw reload. A hard reload re-fetches the app URL, and if the
  // server port rotated (restart-on-conflict) the reloaded window hits a dead
  // port and loses in-session state — the exact reason raw Ctrl+R/F5 is blocked
  // in window.ts. Instead re-navigate to the LIVE tokenized URL so the muscle-
  // memory shortcut works without that breakage.
  const safeReloadAction = () => {
    const win = getMainWindow();
    if (win) win.loadURL(tokenizedAppUrl());
  };
  const toggleAgentsAction = () => triggerRenderer("typeof toggleAgentFeeds === 'function' && toggleAgentFeeds()");
  const toggleDevToolsAction = () => getMainWindow()?.webContents.toggleDevTools();
  const openInBrowserAction = () => { shell.openExternal(tokenizedAppUrl()); };
  const copyAppUrlAction = () => { clipboard.writeText(tokenizedAppUrl()); };

  if (process.platform !== "darwin") {
    setupWindowsAccelerators({
      restartServerAction, safeReloadAction, toggleAgentsAction,
      toggleDevToolsAction, openInBrowserAction, copyAppUrlAction,
    });
    return;
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open in Browser",
          accelerator: "CmdOrCtrl+Shift+B",
          click: openInBrowserAction,
        },
        {
          label: "Copy App URL",
          accelerator: "CmdOrCtrl+Shift+L",
          // Useful escape hatch — paste into Chrome to compare LAX in a
          // real browser (Web Speech API works, no Electron quirks), or
          // share with another tool on the same machine that needs the
          // tokenized link. Reads live from config so a server restart
          // (which can rotate the port on conflict) is reflected.
          click: copyAppUrlAction,
        },
        { type: "separator" },
        {
          label: "Restart Server",
          accelerator: "CmdOrCtrl+Shift+R",
          // Route through the shared restartServer() helper so the
          // native macOS menu and the IPC-driven titlebar (Windows/
          // Linux) take exactly the same steps: stop → reload config
          // → start → wait for ready → reload window URL. The inline
          // stopServer()+startServer() this used to do was missing
          // setRestarting/waitForServer/loadURL — the server actually
          // restarted but the window kept polling the dead URL.
          click: restartServerAction,
        },
        { type: "separator" },
        // close-to-tray is wired on mainWindow's close handler, so this
        // hides the window instead of quitting the app.
        { role: "close", label: "Close to Tray" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // Cmd-R only works when DevTools is focused by default;
        // non-technical users won't discover that. Bind it here.
        // forceReload (Cmd-Shift-R) is intentionally NOT bound — that
        // accelerator already triggers File → Restart Server above.
        { role: "reload", accelerator: "CmdOrCtrl+R" },
        { role: "forceReload" },
        { type: "separator" },
        {
          label: "Show / Hide Agents",
          accelerator: "CmdOrCtrl+Shift+A",
          click: toggleAgentsAction,
        },
        { type: "separator" },
        // Mac's standard zoom is Cmd (⌘+ / ⌘- / ⌘0), shown on these items. We
        // ALSO bind plain Ctrl as a hidden cross-platform alias so the same
        // Ctrl +/-/0 that Windows/Linux use works on Mac too. Plain "=" avoids
        // the Shift the default zoomIn role needs; the keypad "+" is covered too.
        { role: "resetZoom" }, // ⌘0
        { role: "resetZoom", accelerator: "Control+0", visible: false },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" }, // ⌘+
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomIn", accelerator: "Control+=", visible: false },
        { role: "zoomIn", accelerator: "Control+Plus", visible: false },
        { role: "zoomOut" }, // ⌘-
        { role: "zoomOut", accelerator: "Control+-", visible: false },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "front" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Local Agent X",
          click: () => app.showAboutPanel(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface AcceleratorActions {
  restartServerAction: () => void;
  safeReloadAction: () => void;
  toggleAgentsAction: () => void;
  toggleDevToolsAction: () => void;
  openInBrowserAction: () => void;
  copyAppUrlAction: () => void;
}

// Windows/Linux: a hidden accelerator-only menu. The bar itself stays invisible
// (autoHideMenuBar + no Alt reveal) so the in-window titlebar remains the only
// visible chrome, but Electron still registers every accelerator below — which
// is the one thing the click-only custom titlebar could not do. Mirrors the Mac
// menu's shortcuts from the same action closures.
//
// Native roles cover editing (undo/redo/cut/copy/paste/selectAll) and minimize
// so those keys work in inputs; zoom is intentionally omitted here because
// window.ts owns Ctrl +/-/0 (it must resize the titlebar overlay in lockstep,
// which a plain zoom role can't). Ctrl+R maps to safeReloadAction, NOT the
// native reload role, so it re-navigates the live URL instead of a raw refresh.
function setupWindowsAccelerators(a: AcceleratorActions): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "App",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: a.safeReloadAction },
        { label: "Restart Server", accelerator: "CmdOrCtrl+Shift+R", click: a.restartServerAction },
        { label: "Toggle Agents", accelerator: "CmdOrCtrl+Shift+A", click: a.toggleAgentsAction },
        { label: "Toggle DevTools", accelerator: "CmdOrCtrl+Shift+I", click: a.toggleDevToolsAction },
        { label: "Open in Browser", accelerator: "CmdOrCtrl+Shift+B", click: a.openInBrowserAction },
        { label: "Copy App URL", accelerator: "CmdOrCtrl+Shift+L", click: a.copyAppUrlAction },
        { role: "minimize" },
      ],
    },
  ];
  // Registers the accelerators app-wide (independent of any window existing yet,
  // so it's safe to call before createWindow). The menu bar is kept invisible by
  // autoHideMenuBar in the BrowserWindow constructor (window.ts).
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
