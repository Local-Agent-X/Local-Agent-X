// The default image engine setting: the one-time move off preferGrokForMedia,
// the reader's default, and the settings route saving it and telling open tabs.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadSettings, settingsPath } from "../../settings.js";
import { loadConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig } from "../../types.js";
import { imageEngineSetting, migrateImageEngineSetting } from "./image-engine.js";
import { handlePreferencesRoutes } from "../../routes/settings/preferences.js";

const routeMocks = vi.hoisted(() => ({ broadcastAll: vi.fn(() => 1) }));
vi.mock("../../chat-ws/index.js", () => ({ broadcastAll: routeMocks.broadcastAll }));

let dir = "";
let savedLaxDir: string | undefined;
let savedRuntime: LAXConfig | undefined;
beforeAll(() => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-image-engine-"));
  process.env.LAX_DATA_DIR = dir;
  try { savedRuntime = loadConfig(); } catch { savedRuntime = undefined; }
});
afterAll(() => {
  if (savedRuntime) setRuntimeConfig(savedRuntime);
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedLaxDir;
  reloadSettings();
  rmSync(dir, { recursive: true, force: true });
});

function writeSettings(s: Record<string, unknown>): void {
  writeFileSync(settingsPath(), JSON.stringify(s));
  reloadSettings();
}
const onDisk = () => JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;

describe("migrating preferGrokForMedia", () => {
  beforeEach(() => { if (existsSync(settingsPath())) rmSync(settingsPath()); reloadSettings(); });

  it("true becomes Grok and the old key is removed", () => {
    writeSettings({ provider: "anthropic", preferGrokForMedia: true });
    expect(migrateImageEngineSetting()).toBe(true);
    expect(onDisk()).toEqual({ provider: "anthropic", imageEngine: "grok" });
    expect(imageEngineSetting()).toBe("grok");
  });

  it("false (Grok turned off) becomes ChatGPT", () => {
    writeSettings({ provider: "anthropic", preferGrokForMedia: false });
    expect(migrateImageEngineSetting()).toBe(true);
    expect(onDisk()).toEqual({ provider: "anthropic", imageEngine: "chatgpt" });
    expect(imageEngineSetting()).toBe("chatgpt");
  });

  it("absent leaves the file alone and reads as Grok", () => {
    writeSettings({ provider: "anthropic" });
    expect(migrateImageEngineSetting()).toBe(false);
    expect(onDisk()).toEqual({ provider: "anthropic" });
    expect(imageEngineSetting()).toBe("grok");
  });

  it("runs once: a second boot changes nothing, and a saved engine is kept", () => {
    writeSettings({ preferGrokForMedia: false, imageEngine: "grok" });
    expect(migrateImageEngineSetting()).toBe(true);
    expect(onDisk()).toEqual({ imageEngine: "grok" });
    expect(migrateImageEngineSetting()).toBe(false);
  });

  it("drops a stored value that is no engine", () => {
    writeSettings({ imageEngine: "sd-local" });
    expect(migrateImageEngineSetting()).toBe(true);
    expect(onDisk()).toEqual({});
    writeSettings({ imageEngine: "dalle", preferGrokForMedia: false });
    migrateImageEngineSetting();
    expect(onDisk()).toEqual({ imageEngine: "chatgpt" });
  });
});

describe("POST /api/settings with imageEngine", () => {
  async function post(body: unknown, token: string) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
    req.headers = { authorization: `Bearer ${token}` };
    const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, end(c?: string) { if (c) res.body = c; return res; } };
    const config = loadConfig();
    config.authToken = token;
    setRuntimeConfig(config);
    await handlePreferencesRoutes(
      "POST", new URL("http://127.0.0.1/api/settings"),
      req as unknown as Parameters<typeof handlePreferencesRoutes>[2],
      res as unknown as Parameters<typeof handlePreferencesRoutes>[3],
      { config, dataDir: dir } as unknown as Parameters<typeof handlePreferencesRoutes>[4],
      "operator",
    );
    return res;
  }

  it("saves the pick and broadcasts settings_changed so other tabs redraw", async () => {
    writeSettings({ provider: "anthropic" });
    routeMocks.broadcastAll.mockClear();
    const res = await post({ imageEngine: "chatgpt" }, "operator-token");
    expect(res.statusCode).toBe(200);
    expect(onDisk().imageEngine).toBe("chatgpt");
    expect(imageEngineSetting()).toBe("chatgpt");
    expect(routeMocks.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { imageEngine: "chatgpt" } });
  });

  it("refuses the old key, which no longer exists", async () => {
    const res = await post({ preferGrokForMedia: false }, "operator-token");
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/No such setting: preferGrokForMedia/);
  });
});
