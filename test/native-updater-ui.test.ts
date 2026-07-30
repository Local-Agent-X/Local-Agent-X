// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../public/js/app.js"), "utf8");
const updateSource = source.slice(
  source.indexOf("// ── Update checker"),
  source.indexOf("// ── Subsystem health banner"),
);

function loadUI(options: {
  state?: Record<string, unknown>;
  server?: Record<string, unknown>;
  bridge?: boolean;
  getStateError?: Error;
} = {}) {
  document.body.innerHTML =
    '<div id="update-banner" style="display:none"></div><div id="settings-update-status"></div>';
  sessionStorage.clear();
  const listeners: Array<(state: unknown) => void> = [];
  const install = vi.fn().mockResolvedValue(true);
  const check = vi.fn().mockResolvedValue(options.state || { phase: "idle", currentVersion: "1.0.0" });
  const getState = vi.fn().mockResolvedValue(options.state || { phase: "idle", currentVersion: "1.0.0" });
  if (options.getStateError) getState.mockRejectedValue(options.getStateError);
  const bridge = { install, check, getState, onState: vi.fn((cb) => listeners.push(cb)) };
  (window as any).desktop = options.bridge === false ? undefined : { nativeUpdater: bridge };
  const apiFetch = vi.fn().mockResolvedValue({
    json: async () => options.server || { updateAvailable: false, localVersion: "1.0.0" },
  });
  const factory = new Function(
    "apiFetch",
    "esc",
    `${updateSource}
     return { renderUpdateBanner, renderSettingsUpdate, nativeUpdaterInstall, laxCheckUpdates };`,
  );
  const api = factory(apiFetch, (value: unknown) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  return { ...api, bridge, listeners, apiFetch };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("packaged native updater UI", () => {
  beforeEach(() => {
    delete (window as any)._laxNativeUpdaterSubscribed;
    delete (window as any)._laxNativeInstallerUrl;
    delete (window as any)._laxSettingsNativeInstallerUrl;
  });

  it("subscribes once and updates both surfaces from native progress", async () => {
    const ui = loadUI({
      state: { phase: "downloading", currentVersion: "1.0.0", availableVersion: "1.1.0", percent: 42.4 },
      server: { updateAvailable: true, remoteVersion: "9.0.0" },
    });
    await settle();
    expect(ui.bridge.onState).toHaveBeenCalledTimes(1);
    expect(ui.bridge.check).not.toHaveBeenCalled();
    expect(document.getElementById("update-banner")!.textContent).toContain("42%");
    expect(document.getElementById("settings-update-status")!.textContent).toContain("42%");
    expect(document.getElementById("update-banner")!.textContent).not.toContain("9.0.0");
    ui.listeners[0]({ phase: "ready", currentVersion: "1.0.0", availableVersion: "1.1.0" });
    expect(document.getElementById("update-banner")!.textContent).toContain("Restart to Update");
    expect(document.getElementById("settings-update-status")!.textContent).toContain("Restart to Update");
  });

  it("checks the native updater exactly once during a manual check", async () => {
    const ui = loadUI();
    await settle();
    expect(ui.bridge.check).not.toHaveBeenCalled();
    await ui.laxCheckUpdates(true);
    expect(ui.bridge.check).toHaveBeenCalledTimes(1);
  });

  it("renders an escaped error when the initial state read fails", async () => {
    loadUI({ getStateError: new Error("<state unavailable>") });
    await settle();
    const banner = document.getElementById("update-banner")!;
    expect(banner.textContent).toContain("state unavailable");
    expect(banner.textContent).toContain("Retry");
    expect(banner.innerHTML).toContain("&lt;state unavailable&gt;");
  });

  it("deduplicates Restart to Update while install is pending", async () => {
    let finish!: (value: boolean) => void;
    const ui = loadUI({ state: { phase: "ready", currentVersion: "1.0.0", availableVersion: "1.1.0" } });
    ui.bridge.install.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await settle();
    const first = ui.nativeUpdaterInstall();
    const second = ui.nativeUpdaterInstall();
    expect(ui.bridge.install).toHaveBeenCalledTimes(1);
    finish(true);
    await Promise.all([first, second]);
  });

  it("shows Retry and the installer fallback after a native error", async () => {
    loadUI({
      state: { phase: "error", currentVersion: "1.0.0", error: "<unsafe>" },
      server: { nativeUpdateRequired: true, nativeInstallerUrl: "https://example.test/update.dmg" },
    });
    await settle();
    const banner = document.getElementById("update-banner")!;
    expect(banner.textContent).toContain("Retry");
    expect(banner.textContent).toContain("Download Installer");
    expect(banner.innerHTML).toContain("&lt;unsafe&gt;");
    expect((window as any)._laxNativeInstallerUrl).toBe("https://example.test/update.dmg");
  });

  it("keeps the legacy installer flow when the bridge is absent", async () => {
    loadUI({
      bridge: false,
      server: { nativeUpdateRequired: true, nativeInstallerUrl: "https://example.test/update.exe" },
    });
    await settle();
    expect(document.getElementById("update-banner")!.textContent).toContain("Download Update");
    expect(document.getElementById("settings-update-status")!.textContent).toContain("Download Update");
  });
});
