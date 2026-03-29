/**
 * System Tray — icon with context menu for quick actions.
 */

import { Tray, Menu, nativeImage } from "electron";

interface TrayConfig {
  iconPath: string;
  onShow: () => void;
  onToggle: () => void;
  onQuit: () => void;
  onNewSession: () => void;
  getServerStatus: () => Promise<boolean>;
  onRestartServer: () => void;
}

let tray: Tray | null = null;

export function createTray(config: TrayConfig): void {
  const icon = nativeImage.createFromPath(config.iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Open Agent X");

  const buildMenu = (serverOnline: boolean) =>
    Menu.buildFromTemplate([
      {
        label: "Open Agent X",
        type: "normal",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Show Window",
        click: config.onShow,
        accelerator: "CommandOrControl+Shift+Space",
      },
      {
        label: "New Session",
        click: config.onNewSession,
      },
      { type: "separator" },
      {
        label: serverOnline ? "Server: Online" : "Server: Offline",
        enabled: false,
      },
      {
        label: "Restart Server",
        click: config.onRestartServer,
      },
      { type: "separator" },
      {
        label: "Quit",
        click: config.onQuit,
      },
    ]);

  // Initial menu (assume online, will update)
  tray.setContextMenu(buildMenu(true));

  // Update server status in menu periodically
  const updateMenu = async () => {
    if (!tray) return;
    const online = await config.getServerStatus();
    tray.setContextMenu(buildMenu(online));
  };
  setInterval(updateMenu, 10000);
  updateMenu();

  // Left click = toggle window
  tray.on("click", config.onToggle);

  // Double click = show window
  tray.on("double-click", config.onShow);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
