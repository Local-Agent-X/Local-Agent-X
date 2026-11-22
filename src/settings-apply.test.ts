// applySettings is the one way a setting changes: settings.json, the running
// config and config.json for runtime fields, what a changed field must do at
// once, and a broadcast of every broadcast field to open tabs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "./config-schema.js";
import { getConfigPath, getRuntimeConfig, setRuntimeConfig } from "./config.js";
import { reloadSettings, settingsPath } from "./settings.js";
import type { LAXConfig } from "./types.js";

const { frames, closeAllBrowsers, activateLocalOnlyMode } = vi.hoisted(() => ({
  frames: [] as unknown[],
  closeAllBrowsers: vi.fn(async () => {}),
  activateLocalOnlyMode: vi.fn(async () => {}),
}));
vi.mock("./chat-ws/index.js", () => ({ broadcastAll: (frame: unknown) => { frames.push(frame); return 2; } }));
vi.mock("./browser/index.js", () => ({ closeAllBrowsers }));
vi.mock("./local-only-policy.js", async (orig) => ({ ...(await orig<typeof import("./local-only-policy.js")>()), activateLocalOnlyMode }));

const { applySettings } = await import("./settings-apply.js");

const live = () => getRuntimeConfig() as unknown as Record<string, unknown>;
const onDisk = (path: string) => JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

let dir = "";
const prev = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-settings-apply-"));
  process.env.LAX_DATA_DIR = dir;
  reloadSettings();
  setRuntimeConfig(configSchema.parse({ enableComputerControl: true, enableRemoteControl: true }) as LAXConfig);
  frames.length = 0;
  closeAllBrowsers.mockClear();
  activateLocalOnlyMode.mockClear();
});

afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  reloadSettings();
  rmSync(dir, { recursive: true, force: true });
});

describe("applySettings", () => {
  it("writes a runtime field to the running config, config.json and settings.json, and tells open tabs", async () => {
    const r = await applySettings({ enableComputerControl: false, enableRemoteControl: false });
    expect(live().enableComputerControl).toBe(false);
    expect(live().enableRemoteControl).toBe(false);
    expect(onDisk(getConfigPath())).toMatchObject({ enableComputerControl: false, enableRemoteControl: false });
    expect(onDisk(settingsPath())).toMatchObject({ enableComputerControl: false, enableRemoteControl: false });
    // Both fields reach the tabs — the panic disarm used to broadcast only one.
    expect(frames).toEqual([{ type: "settings_changed", settings: { enableComputerControl: false, enableRemoteControl: false } }]);
    expect(r.runtimeChanged.sort()).toEqual(["enableComputerControl", "enableRemoteControl"]);
    expect(r.broadcastTo).toBe(2);
  });

  it("holds the new value in the running config before its first await", () => {
    const pending = applySettings({ enableComputerControl: false });
    expect(live().enableComputerControl).toBe(false);
    return pending;
  });

  it("keeps an invalid value out of the running config and the broadcast", async () => {
    const before = live().browserMode;
    const r = await applySettings({ browserMode: "no-such-mode" });
    expect(live().browserMode).toBe(before);
    expect(r.valid).toEqual({});
    expect(frames).toEqual([]);
  });

  it("closes the open browsers when the browser mode changes, and only then", async () => {
    const other = live().browserMode === "continuity" ? "isolated" : "continuity";
    await applySettings({ browserMode: other });
    expect(closeAllBrowsers).toHaveBeenCalledTimes(1);
    await applySettings({ browserMode: other });
    expect(closeAllBrowsers).toHaveBeenCalledTimes(1);
  });

  it("enters local-only mode when it is switched on", async () => {
    await applySettings({ localOnlyMode: true });
    expect(activateLocalOnlyMode).toHaveBeenCalledTimes(1);
    await applySettings({ localOnlyMode: false });
    expect(activateLocalOnlyMode).toHaveBeenCalledTimes(1);
  });
});
