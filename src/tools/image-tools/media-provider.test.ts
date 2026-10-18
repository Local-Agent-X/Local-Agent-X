// Which backend an image, edit or video call lands on: an explicit backend
// first, then the engine of the chat provider, then the user's default engine
// (`imageEngine`), then the other engine with a note saying so. Credentials,
// settings and the network are mocked throughout.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig, ToolResult } from "../../types.js";

const PNG = Buffer.from("89504E470D0A1A0A0000000D49484452", "hex");
const PNG_B64 = PNG.toString("base64");
const SOURCE = `data:image/png;base64,${PNG_B64}`;
const TOKEN = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url")}.sig`;

let creds: Record<string, string | undefined> = {};
let settingsBag: Record<string, unknown> = {};
const fetchCalls: Array<{ url: string; opts: { headers?: Record<string, string> } }> = [];

vi.mock("../../auth/resolve.js", () => ({
  resolveCredential: async (provider: string) => (creds[provider] ? { provider, credential: creds[provider], source: "oauth" } : null),
}));
vi.mock("../../settings.js", async (orig) => ({ ...(await orig<typeof import("../../settings.js")>()), loadSettings: () => settingsBag }));
vi.mock("../web-egress.js", async (orig) => ({
  ...(await orig<typeof import("../web-egress.js")>()),
  canonicalFetch: vi.fn(async (url: string, opts: (typeof fetchCalls)[number]["opts"] = {}) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG_B64 }] }), text: async () => "" };
  }),
}));

const { resolveMediaProvider } = await import("./shared.js");
const { generateImageTool } = await import("./generate-image.js");
const { editImageTool } = await import("./edit-image.js");

const ALL = { xai: "xai-key", codex: TOKEN, openai: "sk-api" };
const providerOf = async (explicit?: string) => (await resolveMediaProvider(explicit)).provider;

let saved: LAXConfig | undefined;
let workspace = "";
beforeAll(() => {
  try { saved = getRuntimeConfig(); } catch { saved = undefined; }
  workspace = mkdtempSync(join(tmpdir(), "lax-media-provider-"));
  setRuntimeConfig({ ...(saved ?? {}), workspace } as unknown as LAXConfig);
});
afterAll(() => {
  if (saved) setRuntimeConfig(saved);
  rmSync(workspace, { recursive: true, force: true });
});
beforeEach(() => {
  creds = { ...ALL };
  settingsBag = {};
  fetchCalls.length = 0;
});

describe("an explicit backend wins", () => {
  it("over the chat provider and the default engine", async () => {
    settingsBag = { provider: "xai", imageEngine: "grok" };
    expect(await resolveMediaProvider("chatgpt")).toEqual({ provider: "codex", apiKey: TOKEN, forced: true });
    expect(await resolveMediaProvider("openai")).toEqual({ provider: "openai", apiKey: "sk-api", forced: true });
    settingsBag = { provider: "codex", imageEngine: "chatgpt" };
    expect(await resolveMediaProvider("grok")).toEqual({ provider: "xai", apiKey: "xai-key", forced: true });
    expect(await resolveMediaProvider("local")).toMatchObject({ provider: "local", forced: true });
  });
});

describe("images follow the chat provider", () => {
  it("a Grok chat makes images on Grok, whatever the default engine", async () => {
    settingsBag = { provider: "xai", imageEngine: "chatgpt" };
    expect(await resolveMediaProvider()).toEqual({ provider: "xai", apiKey: "xai-key", forced: false });
  });

  it("a ChatGPT chat makes images on the subscription even with xAI connected", async () => {
    settingsBag = { provider: "codex", imageEngine: "grok" };
    expect(await resolveMediaProvider()).toEqual({ provider: "codex", apiKey: TOKEN, forced: false });
  });

  it("an OpenAI chat uses the subscription when signed in, else the API key, never Grok", async () => {
    settingsBag = { provider: "openai", imageEngine: "grok" };
    expect(await providerOf()).toBe("codex");
    creds = { xai: "xai-key", openai: "sk-api" };
    expect(await resolveMediaProvider()).toEqual({ provider: "openai", apiKey: "sk-api", forced: false });
  });
});

describe("any other chat uses the default engine", () => {
  for (const provider of ["anthropic", "gemini", "local"]) {
    it(`a ${provider} chat follows imageEngine, Grok when unset`, async () => {
      settingsBag = { provider };
      expect(await resolveMediaProvider()).toEqual({ provider: "xai", apiKey: "xai-key", forced: false });
      settingsBag = { provider, imageEngine: "grok" };
      expect(await providerOf()).toBe("xai");
      settingsBag = { provider, imageEngine: "chatgpt" };
      expect(await resolveMediaProvider()).toEqual({ provider: "codex", apiKey: TOKEN, forced: false });
    });
  }

  it("a stored value that is no engine reads as Grok", async () => {
    settingsBag = { provider: "anthropic", imageEngine: "dalle" };
    expect(await providerOf()).toBe("xai");
  });

  it("ChatGPT as the default uses the API key when there is no sign-in", async () => {
    settingsBag = { provider: "anthropic", imageEngine: "chatgpt" };
    creds = { xai: "xai-key", openai: "sk-api" };
    expect(await resolveMediaProvider()).toEqual({ provider: "openai", apiKey: "sk-api", forced: false });
  });
});

describe("a default engine that isn't connected", () => {
  it("falls to the other engine and says so", async () => {
    settingsBag = { provider: "anthropic", imageEngine: "grok" };
    creds = { codex: TOKEN };
    expect(await resolveMediaProvider()).toEqual({
      provider: "codex", apiKey: TOKEN, forced: false, note: "Made with ChatGPT; Grok isn't connected.",
    });
    settingsBag = { provider: "anthropic", imageEngine: "chatgpt" };
    creds = { xai: "xai-key" };
    expect(await resolveMediaProvider()).toEqual({
      provider: "xai", apiKey: "xai-key", forced: false, note: "Made with Grok; ChatGPT isn't connected.",
    });
  });

  it("with neither connected, keeps the local path and today's errors", async () => {
    settingsBag = { provider: "anthropic", imageEngine: "grok" };
    creds = {};
    expect(await resolveMediaProvider()).toEqual({ provider: "anthropic", forced: false });
    const r = await editImageTool.execute({ prompt: "x", image: SOURCE });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/isn't connected/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("generate_image and edit_image put the note in the result text", async () => {
    settingsBag = { provider: "anthropic", imageEngine: "grok" };
    creds = { codex: TOKEN };
    const gen = await generateImageTool.execute({ prompt: "a fox" });
    expect(gen.isError).toBeFalsy();
    expect(gen.content).toMatch(/via ChatGPT/);
    expect(gen.content).toMatch(/Made with ChatGPT; Grok isn't connected\.$/);
    const edit = await editImageTool.execute({ prompt: "add a hat", image: SOURCE });
    expect(edit.content).toMatch(/Made with ChatGPT; Grok isn't connected\.$/);
  });

  it("a failed call made nothing, so it carries no \"Made with\" note", async () => {
    settingsBag = { provider: "anthropic", imageEngine: "grok" };
    creds = { codex: TOKEN };
    const { canonicalFetch } = await import("../web-egress.js");
    vi.mocked(canonicalFetch).mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" } as never);
    const gen = await generateImageTool.execute({ prompt: "a fox" });
    expect(gen.isError).toBe(true);
    expect(gen.content).toMatch(/ChatGPT image generation failed \(429\)/);
    expect(gen.content).not.toMatch(/Made with/);
  });

  it("a connected default adds no note", async () => {
    settingsBag = { provider: "anthropic", imageEngine: "grok" };
    const gen = await generateImageTool.execute({ prompt: "a fox" });
    expect(gen.content).toMatch(/via Grok Imagine/);
    expect(gen.content).not.toMatch(/Made with/);
  });
});

describe("masked edits stay on the OpenAI API key", () => {
  for (const [provider, imageEngine] of [["codex", "grok"], ["xai", "grok"], ["anthropic", "chatgpt"]]) {
    it(`a ${provider} chat with ${imageEngine} as the default`, async () => {
      settingsBag = { provider, imageEngine };
      const r = await editImageTool.execute({ prompt: "x", image: SOURCE, mask: SOURCE }) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(fetchCalls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/images/edits"]);
      expect(fetchCalls[0].opts.headers?.Authorization).toBe("Bearer sk-api");
      fetchCalls.length = 0;
    });
  }

  it("and are refused, not rerouted, without an API key", async () => {
    settingsBag = { provider: "codex" };
    creds = { codex: TOKEN, xai: "xai-key" };
    const r = await editImageTool.execute({ prompt: "x", image: SOURCE, mask: SOURCE });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Masked editing needs OpenAI/);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("video has no ChatGPT backend", () => {
  it("is Grok whenever xAI is connected, even when GPT wins images", async () => {
    for (const s of [{ provider: "codex" }, { provider: "openai" }, { provider: "anthropic", imageEngine: "chatgpt" }]) {
      settingsBag = s;
      expect(await providerOf()).not.toBe("xai");
      expect(await resolveMediaProvider(undefined, "video")).toEqual({ provider: "xai", apiKey: "xai-key", forced: false });
    }
  });

  it("takes the local path without xAI", async () => {
    settingsBag = { provider: "codex", imageEngine: "chatgpt" };
    creds = { codex: TOKEN, openai: "sk-api" };
    expect(await resolveMediaProvider(undefined, "video")).toEqual({ provider: "local", forced: false });
  });
});
