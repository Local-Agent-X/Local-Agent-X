// The panic hotkey's disarm turns off both input switches and tells every open
// tab about both. The caller used to broadcast only enableComputerControl, so a
// tab kept showing remote control on after the panic stop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "./config-schema.js";
import { getRuntimeConfig, setRuntimeConfig } from "./config.js";
import { reloadSettings } from "./settings.js";
import type { LAXConfig } from "./types.js";

const { frames } = vi.hoisted(() => ({ frames: [] as unknown[] }));
vi.mock("./chat-ws/index.js", () => ({ broadcastAll: (frame: unknown) => { frames.push(frame); return 1; } }));

const { disarmComputerControl } = await import("./computer-control.js");

let dir = "";
const prev = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-disarm-"));
  process.env.LAX_DATA_DIR = dir;
  reloadSettings();
  setRuntimeConfig(configSchema.parse({ enableComputerControl: true, enableRemoteControl: true }) as LAXConfig);
  frames.length = 0;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  reloadSettings();
  rmSync(dir, { recursive: true, force: true });
});

describe("disarmComputerControl", () => {
  it("turns both switches off at once and tells open tabs about both", async () => {
    const done = disarmComputerControl();
    const live = getRuntimeConfig() as unknown as Record<string, unknown>;
    expect(live.enableComputerControl).toBe(false);
    expect(live.enableRemoteControl).toBe(false);
    await done;
    expect(frames).toEqual([{ type: "settings_changed", settings: { enableComputerControl: false, enableRemoteControl: false } }]);
  });
});
