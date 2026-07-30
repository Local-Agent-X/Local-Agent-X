import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";

import { setQuitting, stopServer } from "./server-process";
import { getMainWindow } from "./window";

export type NativeUpdaterPhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface NativeUpdaterState {
  phase: NativeUpdaterPhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  error?: string;
}

interface UpdateInfo {
  version: string;
}

interface DownloadProgress {
  percent?: number;
  transferred?: number;
  total?: number;
}

export interface UpdaterDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available" | "update-not-available" | "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (progress: DownloadProgress) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface NativeUpdaterDependencies {
  updater: UpdaterDriver;
  packaged: boolean;
  platform: NodeJS.Platform;
  currentVersion: string;
  broadcast: (state: NativeUpdaterState) => void;
  prepareToQuit: () => Promise<void>;
  log: Pick<Console, "info" | "warn" | "error">;
}

export interface NativeUpdaterAdapter {
  initialize(): void;
  getState(): NativeUpdaterState;
  check(): Promise<NativeUpdaterState>;
  install(): Promise<boolean>;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "the update service")
    .replace(/([?&](?:token|key|signature|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1[redacted]")
    .replace(/((?:access[_-]?token|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .slice(0, 240);
}

export function createNativeUpdater(deps: NativeUpdaterDependencies): NativeUpdaterAdapter {
  const supported = deps.packaged && (deps.platform === "darwin" || deps.platform === "win32");
  let initialized = false;
  let installing = false;
  let state: NativeUpdaterState = {
    phase: supported ? "idle" : "unavailable",
    currentVersion: deps.currentVersion,
  };

  const updateState = (patch: Partial<NativeUpdaterState>): void => {
    state = { ...state, ...patch };
    deps.broadcast({ ...state });
  };

  const check = async (): Promise<NativeUpdaterState> => {
    if (!supported) return { ...state };
    updateState({ phase: "checking", error: undefined });
    try {
      await deps.updater.checkForUpdates();
    } catch (error) {
      const message = safeError(error);
      deps.log.error("[native-updater] update check failed:", message);
      updateState({ phase: "error", error: message });
    }
    return { ...state };
  };

  const initialize = (): void => {
    if (initialized || !supported) return;
    initialized = true;
    deps.updater.autoDownload = true;
    deps.updater.autoInstallOnAppQuit = false;
    deps.updater.logger = {
      info: (message: unknown) => deps.log.info("[native-updater]", safeError(message)),
      warn: (message: unknown) => deps.log.warn("[native-updater]", safeError(message)),
      error: (message: unknown) => deps.log.error("[native-updater]", safeError(message)),
      debug: (message: unknown) => deps.log.info("[native-updater]", safeError(message)),
    };
    deps.updater.on("checking-for-update", () => updateState({ phase: "checking", error: undefined }));
    deps.updater.on("update-available", (info) => {
      updateState({ phase: "available", availableVersion: info.version });
    });
    deps.updater.on("update-not-available", () => {
      updateState({ phase: "idle", availableVersion: undefined, percent: undefined });
    });
    deps.updater.on("download-progress", (progress) => {
      updateState({
        phase: "downloading",
        percent: progress.percent,
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
      });
    });
    deps.updater.on("update-downloaded", (info) => {
      updateState({ phase: "ready", availableVersion: info.version, percent: 100 });
    });
    deps.updater.on("error", (error) => {
      const message = safeError(error);
      deps.log.error("[native-updater] updater error:", message);
      updateState({ phase: "error", error: message });
    });
    void check();
  };

  const install = async (): Promise<boolean> => {
    if (!supported || state.phase !== "ready" || installing) return false;
    installing = true;
    try {
      await deps.prepareToQuit();
      deps.updater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      installing = false;
      const message = safeError(error);
      deps.log.error("[native-updater] install failed:", message);
      updateState({ phase: "error", error: message });
      return false;
    }
  };

  return { initialize, getState: () => ({ ...state }), check, install };
}

const adapter = createNativeUpdater({
  updater: autoUpdater,
  packaged: app.isPackaged,
  platform: process.platform,
  currentVersion: app.getVersion(),
  broadcast: (state) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send("native-updater-state", state);
  },
  prepareToQuit: async () => {
    setQuitting(true);
    await stopServer();
  },
  log: console,
});

export function initializeNativeUpdater(): void {
  adapter.initialize();
}

let ipcRegistered = false;

function trusted(event: IpcMainInvokeEvent): boolean {
  const window = getMainWindow();
  return !!window && !window.isDestroyed() && event.sender === window.webContents;
}

export function setupNativeUpdaterIPC(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("native-updater-get-state", (event) =>
    trusted(event) ? adapter.getState() : null);
  ipcMain.handle("native-updater-check", (event) =>
    trusted(event) ? adapter.check() : null);
  ipcMain.handle("native-updater-install", (event) =>
    trusted(event) ? adapter.install() : false);
}
