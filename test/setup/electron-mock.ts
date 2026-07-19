const noop = () => {};

export const app = {
  commandLine: { appendSwitch: noop },
  whenReady: () => Promise.resolve(),
  configureHostResolver: noop,
};

export const session = {
  fromPartition: () => ({
    setPermissionRequestHandler: noop,
    setPermissionCheckHandler: noop,
    on: noop,
    webRequest: { onBeforeRequest: noop, onCompleted: noop, onErrorOccurred: noop, onHeadersReceived: noop },
  }),
};

export const ipcMain = { handle: noop, on: noop };
export const ipcRenderer = { invoke: async () => undefined, on: noop, send: noop };
export const contextBridge = { exposeInMainWorld: noop };
export const shell = { openExternal: async () => undefined, openPath: async () => "" };
export const nativeTheme = { shouldUseDarkColors: false, on: noop };
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
export const clipboard = { readText: () => "", writeText: noop };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: noop };
export const MenuItem = class {};
export const Tray = class {};
export const BrowserWindow = class {};
export const WebContentsView = class {};
