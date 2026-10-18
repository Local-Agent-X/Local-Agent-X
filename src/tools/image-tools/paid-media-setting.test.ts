// The Settings → Media switch for paid API keys: off when unset, saved and
// broadcast by the settings route, turned on only by the user (the agent may
// only turn it off), labelled in the page as the refusals name it, and the one
// gate every provider image or video call in the source goes through.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { reloadSettings, settingsPath } from "../../settings.js";
import { loadConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig } from "../../types.js";
import { PAID_MEDIA_SETTING_LABEL, paidMediaApisAllowed, paidMediaEndpointKind } from "./paid-media.js";
import { handlePreferencesRoutes } from "../../routes/settings/preferences.js";

const routeMocks = vi.hoisted(() => ({ broadcastAll: vi.fn(() => 1) }));
vi.mock("../../chat-ws/index.js", () => ({ broadcastAll: routeMocks.broadcastAll }));

let dir = "";
let savedLaxDir: string | undefined;
let savedRuntime: LAXConfig | undefined;
beforeAll(() => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-paid-media-setting-"));
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

/** POST /api/settings; `sent` is the bearer on the request, the operator token is "operator-token". */
async function post(body: unknown, sent: string) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = { authorization: `Bearer ${sent}` };
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

describe("allowPaidMediaApis", () => {
  it("is off when unset, and only true turns it on", () => {
    if (existsSync(settingsPath())) rmSync(settingsPath());
    reloadSettings();
    expect(paidMediaApisAllowed()).toBe(false);
    writeSettings({ allowPaidMediaApis: "yes" });
    expect(paidMediaApisAllowed()).toBe(false);
    writeSettings({ allowPaidMediaApis: true });
    expect(paidMediaApisAllowed()).toBe(true);
  });

  it("the user's Settings page saves it and broadcasts settings_changed", async () => {
    writeSettings({ provider: "anthropic" });
    routeMocks.broadcastAll.mockClear();
    const res = await post({ allowPaidMediaApis: true }, "operator-token");
    expect(res.statusCode).toBe(200);
    expect(onDisk().allowPaidMediaApis).toBe(true);
    expect(paidMediaApisAllowed()).toBe(true);
    expect(routeMocks.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { allowPaidMediaApis: true } });
  });

  it("the agent may turn it off but not on", async () => {
    writeSettings({ allowPaidMediaApis: false });
    const on = await post({ allowPaidMediaApis: true }, "agent-token");
    expect(on.statusCode).toBe(403);
    expect(onDisk().allowPaidMediaApis).toBe(false);
    writeSettings({ allowPaidMediaApis: true });
    const off = await post({ allowPaidMediaApis: false }, "agent-token");
    expect(off.statusCode).toBe(200);
    expect(onDisk().allowPaidMediaApis).toBe(false);
  });
});

describe("the Settings → Media page", () => {
  const html = readFileSync(join(process.cwd(), "public", "app.html"), "utf-8");
  it("shows the switch under the engine buttons, with the label the refusals name", () => {
    const engine = html.indexOf('id="cfg-image-engine"');
    const toggle = html.indexOf("toolPolicyToggle('allowPaidMediaApis', this)");
    expect(engine).toBeGreaterThan(0);
    expect(toggle).toBeGreaterThan(engine);
    expect(html.slice(engine, toggle)).toContain(`${PAID_MEDIA_SETTING_LABEL} (billed per image/video)`);
  });

  it("redraws on another tab's change", () => {
    const misc = readFileSync(join(process.cwd(), "public", "js", "chat-ws-handler-misc.js"), "utf-8");
    expect(misc).toMatch(/TOOL_POLICY_CARD_FIELDS = \[[^\]]*'allowPaidMediaApis'/);
    const card = readFileSync(join(process.cwd(), "public", "js", "settings-tool-policy.js"), "utf-8");
    expect(card).toContain("setToolPolicyToggle('cfg-toggle-paid-media', s.allowPaidMediaApis === true)");
  });
});

describe("every provider image or video call goes through the gate", () => {
  // A literal route of a provider's image or video API in source. A new file
  // that calls one must take its credential from resolveMediaProvider
  // (shared.ts), which drops paid keys while the switch is off, and be listed
  // here; http_request covers model-written calls via paidMediaEndpointKind.
  const ROUTE = /\/(?:images|videos)\/(?:generations|edits)\b|\/(?:images|videos)\/\$\{|api\.(?:openai\.com|x\.ai)\/v1\/(?:images|videos)/;
  const GATED = ["src/tools/image-tools/generate-image.ts", "src/tools/image-tools/edit-image.ts", "src/tools/image-tools/generate-video.ts"];
  // The ChatGPT subscription's own image routes: a sign-in, never a paid key.
  const SUBSCRIPTION_WIRE = ["src/codex-client/images.ts"];

  function sourceFiles(root: string): string[] {
    return readdirSync(root).flatMap((name) => {
      const p = join(root, name);
      if (statSync(p).isDirectory()) return name === "vendor" || name === "bundled" ? [] : sourceFiles(p);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [relative(process.cwd(), p).split(sep).join("/")] : [];
    });
  }

  it("names a route only in the gated tools and the subscription's wire module", () => {
    const code = (f: string) => readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const naming = sourceFiles(join(process.cwd(), "src")).filter((f) => ROUTE.test(code(f)));
    expect(naming.sort()).toEqual([...GATED, ...SUBSCRIPTION_WIRE].sort());
  });

  it("each gated tool resolves its credential through resolveMediaProvider", () => {
    for (const f of GATED) {
      const text = readFileSync(join(process.cwd(), f), "utf-8");
      expect(text, f).toMatch(/resolveMediaProvider\(/);
      expect(text, f).not.toMatch(/resolveCredential|getSecretsStoreSingleton|process\.env/);
    }
  });

  it("http_request recognizes each route those tools call with a key", () => {
    expect(paidMediaEndpointKind("https://api.openai.com/v1/images/generations")).toBe("image");
    expect(paidMediaEndpointKind("https://api.openai.com/v1/images/edits")).toBe("image");
    expect(paidMediaEndpointKind("https://API.X.AI/v1/images/generations")).toBe("image");
    expect(paidMediaEndpointKind("https://api.x.ai/v1/videos/generations")).toBe("video");
    expect(paidMediaEndpointKind("https://api.x.ai/v1/videos/abc123")).toBe("video");
    expect(paidMediaEndpointKind("https://api.x.ai/v1/chat/completions")).toBeNull();
    expect(paidMediaEndpointKind("https://chatgpt.com/backend-api/codex/images/generations")).toBeNull();
    expect(paidMediaEndpointKind("not a url")).toBeNull();
  });
});
