// The two server-read settings that had no control in Settings — provider
// failover for background runs and the classifier model pin — each have one on
// the AI & Models tab: declared agent-owned and broadcast, saved and broadcast
// by the settings route, painted at load, and redrawn when another tab changes
// them (frames.test.ts holds the handler keys against the broadcast keys).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BROADCAST_KEYS, FLIPPABLE_SETTINGS, PROTECTED_SETTINGS } from "./settings-schema.js";
import { reloadSettings, settingsPath } from "./settings.js";
import { loadConfig, setRuntimeConfig } from "./config.js";
import type { LAXConfig } from "./types.js";
import { handlePreferencesRoutes } from "./routes/settings/preferences.js";

const routeMocks = vi.hoisted(() => ({ broadcastAll: vi.fn(() => 1) }));
vi.mock("./chat-ws/index.js", () => ({ broadcastAll: routeMocks.broadcastAll }));

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf-8");

describe("the declarations", () => {
  it.each([
    ["allowRuntimeFailover", true, "yes"],
    ["localClassifierModel", "llama3.2:3b", 7],
  ])("%s is agent-owned, broadcast, not protected, and typed", (field, valid, invalid) => {
    const setting = FLIPPABLE_SETTINGS.find((entry) => entry.field === field);
    expect(setting).toMatchObject({ owner: "agent", broadcast: true });
    expect(setting?.validate.safeParse(valid).success).toBe(true);
    expect(setting?.validate.safeParse(invalid).success).toBe(false);
    expect(BROADCAST_KEYS.has(field)).toBe(true);
    expect(PROTECTED_SETTINGS.has(field)).toBe(false);
  });

  it("the classifier pin's description matches what background-model.ts does with an empty value", () => {
    const setting = FLIPPABLE_SETTINGS.find((entry) => entry.field === "localClassifierModel");
    expect(setting?.description).toContain("Empty = the chat model");
    expect(setting?.description).not.toMatch(/auto-pick/);
  });
});

describe("the settings route", () => {
  let dir = "";
  let savedLaxDir: string | undefined;
  let savedRuntime: LAXConfig | undefined;
  beforeAll(() => {
    savedLaxDir = process.env.LAX_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), "lax-runtime-controls-"));
    process.env.LAX_DATA_DIR = dir;
    try { savedRuntime = loadConfig(); } catch { savedRuntime = undefined; }
    writeFileSync(settingsPath(), JSON.stringify({ provider: "local" }));
    reloadSettings();
  });
  afterAll(() => {
    if (savedRuntime) setRuntimeConfig(savedRuntime);
    if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = savedLaxDir;
    reloadSettings();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(body: unknown) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
    req.headers = { authorization: "Bearer operator-token" };
    const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, end(c?: string) { if (c) res.body = c; return res; } };
    const config = loadConfig();
    config.authToken = "operator-token";
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
  const onDisk = () => JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;

  it("saves both controls and broadcasts each as settings_changed", async () => {
    routeMocks.broadcastAll.mockClear();
    expect((await post({ allowRuntimeFailover: true })).statusCode).toBe(200);
    expect(onDisk().allowRuntimeFailover).toBe(true);
    expect(routeMocks.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { allowRuntimeFailover: true } });
    expect((await post({ localClassifierModel: "llama3.2:3b" })).statusCode).toBe(200);
    expect(onDisk().localClassifierModel).toBe("llama3.2:3b");
    expect(routeMocks.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { localClassifierModel: "llama3.2:3b" } });
    // "None": the empty string is the declared value for the chat model.
    expect((await post({ localClassifierModel: "" })).statusCode).toBe(200);
    expect(onDisk().localClassifierModel).toBe("");
  });
});

describe("the AI & Models tab", () => {
  const html = read("public", "app.html");
  const tab = html.slice(html.indexOf('id="stab-ai"'), html.indexOf('id="stab-usage"'));

  it("has the failover switch, off by default, labelled as a switch to another provider", () => {
    expect(tab).toContain(`<div id="cfg-toggle-runtime-failover" class="toggle" onclick="toolPolicyToggle('allowRuntimeFailover', this)">`);
    expect(tab).toContain("Fail over to another provider");
    expect(tab).toMatch(/switch that run to another connected provider or model/);
    expect(tab).toMatch(/announced as a line in that run's activity feed/);
  });

  it("has the classifier model picker, with none as the provider's background model, in the Local Runtimes card", () => {
    const list = tab.indexOf('id="local-runtimes-list"');
    const picker = tab.indexOf('id="cfg-local-classifier-model"');
    expect(list).toBeGreaterThan(0);
    expect(picker).toBeGreaterThan(list);
    expect(tab).toContain(`onchange="saveLocalClassifierModel(this.value)"`);
    expect(tab).toMatch(/<option value="">None — the provider's background model \(your chat model\)<\/option>/);
  });

  it("paints both at load and redraws both on another tab's change", () => {
    const card = read("public", "js", "settings-tool-policy.js");
    expect(card).toContain("setToolPolicyToggle('cfg-toggle-runtime-failover', s.allowRuntimeFailover === true)");
    const runtimes = read("public", "js", "settings-local-runtimes.js");
    expect(runtimes).toContain("renderLocalClassifierPicker(installedLocalModelIds(discovered), settings.localClassifierModel)");
    expect(runtimes).toMatch(/function renderLocalClassifierModel\(value\)/);
    expect(runtimes).toContain("body: JSON.stringify({ localClassifierModel: value })");
    const misc = read("public", "js", "chat-ws-handler-misc.js");
    expect(misc).toMatch(/TOOL_POLICY_CARD_FIELDS = \[[^\]]*'allowRuntimeFailover'/);
    expect(misc).toContain("if ('localClassifierModel' in msg.settings && typeof renderLocalClassifierModel === 'function')");
  });
});
