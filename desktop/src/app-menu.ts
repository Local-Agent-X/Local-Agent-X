// Native macOS application menu. The custom JS-injected in-window
// titlebar is skipped on darwin (Mac uses the native top-of-screen menu
// bar), so every app-specific action that lives in that titlebar — New
// Session, Restart Server, Show/Hide Agents, Toggle DevTools — has to be
// surfaced here or it's lost. Renderer-targeted items dispatch via
// webContents.executeJavaScript, same as the old in-window menu's
// handlers.

import { app, BrowserWindow, Menu, clipboard, shell } from "electron";
import { restartServer } from "./server-process";
import { getLAXConfig } from "./config";

function tokenizedAppUrl(): string {
  const cfg = getLAXConfig();
  return `http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`;
}

export function setupApplicationMenu(getMainWindow: () => BrowserWindow | null): void {
  if (process.platform !== "darwin") return; // Windows/Linux keep the in-window titlebar

  const triggerRenderer = (js: string) => {
    getMainWindow()?.webContents.executeJavaScript(js).catch(() => { /* renderer not ready */ });
  };

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
          click: () => { shell.openExternal(tokenizedAppUrl()); },
        },
        {
          label: "Copy App URL",
          accelerator: "CmdOrCtrl+Shift+L",
          // Useful escape hatch — paste into Chrome to compare LAX in a
          // real browser (Web Speech API works, no Electron quirks), or
          // share with another tool on the same machine that needs the
          // tokenized link. Reads live from config so a server restart
          // (which can rotate the port on conflict) is reflected.
          click: () => { clipboard.writeText(tokenizedAppUrl()); },
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
          click: async () => {
            const { ready, cfg } = await restartServer();
            const win = getMainWindow();
            if (ready && win) {
              win.loadURL(`http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`);
            }
          },
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
          click: () => triggerRenderer("document.getElementById('agents-toggle')?.click()"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        // Bind plain Ctrl+= so zoom-in doesn't require Shift (the default
        // zoomIn role is Ctrl+Plus = Ctrl+Shift+=). Also register the keypad
        // variant so both rows of "+" work.
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
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
