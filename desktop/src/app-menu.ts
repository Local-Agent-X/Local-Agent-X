// Native macOS application menu. The custom JS-injected in-window
// titlebar is skipped on darwin (Mac uses the native top-of-screen menu
// bar), so every app-specific action that lives in that titlebar — New
// Session, Restart Server, Show/Hide Agents, Toggle DevTools — has to be
// surfaced here or it's lost. Renderer-targeted items dispatch via
// webContents.executeJavaScript, same as the old in-window menu's
// handlers.

import { app, BrowserWindow, Menu } from "electron";
import { stopServer, startServer } from "./server-process";

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
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => triggerRenderer("window.startNewSession?.()"),
        },
        { type: "separator" },
        {
          label: "Restart Server",
          accelerator: "CmdOrCtrl+Shift+R",
          click: async () => { await stopServer(); startServer(); },
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
        { role: "zoomIn" },
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
