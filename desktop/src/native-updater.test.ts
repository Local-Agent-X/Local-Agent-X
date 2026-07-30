import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const mainWebContents = { send: vi.fn() };
  return { handlers, mainWebContents };
});

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.5.3" },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: new EventEmitter(),
}));

vi.mock("./window", () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: mocks.mainWebContents,
  }),
}));

vi.mock("./server-process", () => ({
  setQuitting: vi.fn(),
  stopServer: vi.fn(),
}));

import {
  createNativeUpdater,
  setupNativeUpdaterIPC,
  type NativeUpdaterState,
  type UpdaterDriver,
} from "./native-updater";

class FakeUpdater extends EventEmitter implements UpdaterDriver {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  logger: unknown;
  checkForUpdates = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

function createHarness(overrides?: { packaged?: boolean; platform?: NodeJS.Platform }) {
  const updater = new FakeUpdater();
  const states: NativeUpdaterState[] = [];
  const prepareToQuit = vi.fn(async () => undefined);
  const adapter = createNativeUpdater({
    updater,
    packaged: overrides?.packaged ?? true,
    platform: overrides?.platform ?? "darwin",
    currentVersion: "1.0.0",
    broadcast: (state) => states.push(state),
    prepareToQuit,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { adapter, updater, states, prepareToQuit };
}

describe("native updater adapter", () => {
  it("is inert for loose and unsupported installations", async () => {
    for (const options of [
      { packaged: false, platform: "darwin" as NodeJS.Platform },
      { packaged: true, platform: "linux" as NodeJS.Platform },
    ]) {
      const { adapter, updater } = createHarness(options);
      adapter.initialize();
      expect(adapter.getState().phase).toBe("unavailable");
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      expect(await adapter.install()).toBe(false);
    }
  });

  it("automatically checks and downloads without auto-installing", async () => {
    const { adapter, updater, states } = createHarness();
    adapter.initialize();
    adapter.initialize();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce());
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    updater.emit("update-available", { version: "1.1.0" });
    updater.emit("download-progress", { percent: 42, transferred: 420, total: 1000 });
    updater.emit("update-downloaded", { version: "1.1.0" });

    expect(states.map((state) => state.phase)).toEqual([
      "checking", "available", "downloading", "ready",
    ]);
    expect(adapter.getState()).toMatchObject({
      phase: "ready",
      availableVersion: "1.1.0",
      percent: 100,
      transferredBytes: 420,
      totalBytes: 1000,
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("awaits server shutdown before explicit installation", async () => {
    const { adapter, updater, prepareToQuit } = createHarness();
    adapter.initialize();
    updater.emit("update-downloaded", { version: "1.1.0" });

    await expect(adapter.install()).resolves.toBe(true);
    expect(prepareToQuit).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(prepareToQuit.mock.invocationCallOrder[0])
      .toBeLessThan(updater.quitAndInstall.mock.invocationCallOrder[0]);
  });

  it("reports sanitized errors without exposing update URLs", async () => {
    const { adapter, updater } = createHarness();
    updater.checkForUpdates.mockRejectedValueOnce(
      new Error("GET https://updates.example/latest.yml?token=secret failed"),
    );
    adapter.initialize();
    await vi.waitFor(() => expect(adapter.getState().phase).toBe("error"));
    expect(adapter.getState().error).not.toContain("updates.example");
    expect(adapter.getState().error).not.toContain("secret");
  });
});

describe("native updater IPC trust boundary", () => {
  beforeEach(() => mocks.handlers.clear());

  it("rejects calls from any renderer other than the live main window", async () => {
    setupNativeUpdaterIPC();
    const getState = mocks.handlers.get("native-updater-get-state");
    const check = mocks.handlers.get("native-updater-check");
    const install = mocks.handlers.get("native-updater-install");
    expect(getState).toBeDefined();
    expect(await getState?.({ sender: {} })).toBeNull();
    expect(await check?.({ sender: {} })).toBeNull();
    expect(await install?.({ sender: {} })).toBe(false);
  });
});
