// With paid API keys for images and video off (`allowPaidMediaApis`, the
// default), no image, edit or video call uses an OpenAI or xAI API key by any
// route, an explicit paid backend is an error naming the setting, and the
// ChatGPT and SuperGrok sign-ins still work. Whether a credential is paid comes
// from its source. Credentials, settings and the network are mocked; the local
// Stable Diffusion and CogVideoX servers point at a closed port.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig, ToolResult } from "../../types.js";
import type { CredentialSource } from "../../auth/auth-provider.js";

const PNG_B64 = Buffer.from("89504E470D0A1A0A0000000D49484452", "hex").toString("base64");
const SOURCE = `data:image/png;base64,${PNG_B64}`;
const TOKEN = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url")}.sig`;

let creds: Record<string, { credential: string; source: CredentialSource } | undefined> = {};
let settingsBag: Record<string, unknown> = {};
const fetchCalls: Array<{ url: string; opts: { headers?: Record<string, string> } }> = [];

vi.mock("../../auth/resolve.js", () => ({
  resolveCredential: async (provider: string) => (creds[provider] ? { provider, ...creds[provider] } : null),
}));
vi.mock("../../settings.js", async (orig) => ({ ...(await orig<typeof import("../../settings.js")>()), loadSettings: () => settingsBag }));
vi.mock("../web-egress.js", async (orig) => ({
  ...(await orig<typeof import("../web-egress.js")>()),
  canonicalFetch: vi.fn(async (url: string, opts: (typeof fetchCalls)[number]["opts"] = {}) => {
    // The local image and video servers are configured on a closed port (CLOSED
    // below): nothing listens there, so the call fails as a real dial would.
    if (url.startsWith("http://127.0.0.1:9/")) throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    fetchCalls.push({ url, opts });
    const body: unknown = url.includes("/videos/generations") ? { request_id: "r1" } : { data: [{ b64_json: PNG_B64 }] };
    return { ok: true, status: 200, json: async (): Promise<unknown> => body, text: async (): Promise<string> => "" };
  }),
}));

const { resolveMediaProvider } = await import("./shared.js");
const { generateImageTool } = await import("./generate-image.js");
const { editImageTool } = await import("./edit-image.js");
const { generateVideoTool } = await import("./generate-video.js");

const OPENAI_KEY = { credential: "sk-api", source: "secrets-store" } as const;
const XAI_KEY = { credential: "xai-key", source: "env" } as const;
const XAI_OAUTH = { credential: "xai-oauth", source: "oauth" } as const;
const CHATGPT = { credential: TOKEN, source: "oauth" } as const;
const IMAGE_OFF = "Paid API image generation is off — turn on 'Allow paid API keys for images and video' in Settings → Media.";
const VIDEO_OFF = "Paid API video generation is off — turn on 'Allow paid API keys for images and video' in Settings → Media.";
const CLOSED = "http://127.0.0.1:9";

let saved: LAXConfig | undefined;
let workspace = "";
beforeAll(() => {
  try { saved = getRuntimeConfig(); } catch { saved = undefined; }
  workspace = mkdtempSync(join(tmpdir(), "lax-paid-media-"));
  setRuntimeConfig({ ...(saved ?? {}), workspace, sdServerUrl: CLOSED, videoServerUrl: CLOSED } as unknown as LAXConfig);
});
afterAll(() => {
  if (saved) setRuntimeConfig(saved);
  rmSync(workspace, { recursive: true, force: true });
});
beforeEach(() => {
  creds = { openai: OPENAI_KEY, xai: XAI_KEY };
  settingsBag = { provider: "anthropic" };
  fetchCalls.length = 0;
});

const run = (tool: { execute: (a: Record<string, unknown>) => Promise<ToolResult> | ToolResult }, args: Record<string, unknown>) =>
  Promise.resolve(tool.execute(args));

describe("while paid API keys are off", () => {
  it("is the default: an absent setting is off", async () => {
    expect(await resolveMediaProvider()).toEqual({ provider: "anthropic", forced: false });
    settingsBag = { provider: "anthropic", allowPaidMediaApis: false };
    expect(await resolveMediaProvider()).toEqual({ provider: "anthropic", forced: false });
  });

  it("the default never lands on an API key, whatever the chat or engine", async () => {
    for (const s of [{ provider: "xai" }, { provider: "openai" }, { provider: "anthropic", imageEngine: "chatgpt" }, { provider: "gemini", imageEngine: "grok" }]) {
      settingsBag = s;
      expect((await resolveMediaProvider()).apiKey).toBeUndefined();
    }
    const r = await run(generateImageTool, { prompt: "a fox" });
    expect(r.isError).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it("with nothing free available, the error lists every option", async () => {
    const r = await run(generateImageTool, { prompt: "a fox" });
    expect(r.content).toMatch(/No free image generation backend is available/);
    expect(r.content).toMatch(/sign in with ChatGPT or SuperGrok/);
    expect(r.content).toMatch(/local Stable Diffusion/);
    expect(r.content).toContain("turn on 'Allow paid API keys for images and video' in Settings → Media");
    const edit = await run(editImageTool, { prompt: "add a hat", image: SOURCE });
    expect(edit.content).toMatch(/No free image editing backend[\s\S]*sign in with ChatGPT or SuperGrok[\s\S]*Allow paid API keys/);
    const video = await run(generateVideoTool, { prompt: "a fox running" });
    expect(video.content).toMatch(/No free video generation backend[\s\S]*SuperGrok[\s\S]*CogVideoX[\s\S]*Allow paid API keys/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("an explicit 'openai' is refused, naming the setting, even with ChatGPT signed in", async () => {
    creds = { openai: OPENAI_KEY, codex: CHATGPT };
    expect(await resolveMediaProvider("openai")).toEqual({ provider: "openai", forced: true, refusal: IMAGE_OFF });
    for (const tool of [generateImageTool, editImageTool]) {
      const r = await run(tool, { prompt: "x", image: SOURCE, provider: "dall-e" });
      expect(r).toMatchObject({ isError: true, content: IMAGE_OFF });
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it("an explicit 'grok' with only an xAI API key is refused", async () => {
    creds = { xai: XAI_KEY };
    expect(await resolveMediaProvider("grok")).toMatchObject({ refusal: IMAGE_OFF });
    expect(await run(generateImageTool, { prompt: "x", provider: "grok" })).toMatchObject({ isError: true, content: IMAGE_OFF });
    expect(await run(editImageTool, { prompt: "x", image: SOURCE, provider: "grok" })).toMatchObject({ isError: true, content: IMAGE_OFF });
    expect(fetchCalls).toHaveLength(0);
  });

  it("a masked edit is refused, not rerouted to a sign-in", async () => {
    creds = { openai: OPENAI_KEY, codex: CHATGPT, xai: XAI_OAUTH };
    const r = await run(editImageTool, { prompt: "x", image: SOURCE, mask: SOURCE });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(IMAGE_OFF);
    expect(r.content).toMatch(/drop the mask/);
    creds = { codex: CHATGPT };
    const noKey = await run(editImageTool, { prompt: "x", image: SOURCE, mask: SOURCE });
    expect(noKey.content).toMatch(/Masked editing needs OpenAI[\s\S]*Allow paid API keys for images and video/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("video with only an xAI API key takes the local path, and an explicit 'grok' is refused", async () => {
    creds = { xai: XAI_KEY };
    expect(await resolveMediaProvider(undefined, "video")).toEqual({ provider: "local", forced: false });
    expect(await resolveMediaProvider("grok", "video")).toMatchObject({ refusal: VIDEO_OFF });
    expect(await run(generateVideoTool, { prompt: "x", provider: "grok" })).toMatchObject({ isError: true, content: VIDEO_OFF });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("subscriptions work while paid API keys are off", () => {
  it("the ChatGPT sign-in makes and edits images", async () => {
    creds = { openai: OPENAI_KEY, xai: XAI_KEY, codex: CHATGPT };
    settingsBag = { provider: "openai" };
    expect(await resolveMediaProvider()).toEqual({ provider: "codex", apiKey: TOKEN, forced: false });
    const gen = await run(generateImageTool, { prompt: "a fox" });
    expect(gen.isError).toBeFalsy();
    const edit = await run(editImageTool, { prompt: "add a hat", image: SOURCE, provider: "chatgpt" });
    expect(edit.isError).toBeFalsy();
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://chatgpt.com/backend-api/codex/images/generations",
      "https://chatgpt.com/backend-api/codex/images/edits",
    ]);
  });

  it("the SuperGrok sign-in makes images and is the video default", async () => {
    creds = { openai: OPENAI_KEY, xai: XAI_OAUTH };
    settingsBag = { provider: "xai" };
    expect(await resolveMediaProvider()).toEqual({ provider: "xai", apiKey: "xai-oauth", forced: false });
    expect(await resolveMediaProvider("grok")).toEqual({ provider: "xai", apiKey: "xai-oauth", forced: true });
    expect(await resolveMediaProvider(undefined, "video")).toEqual({ provider: "xai", apiKey: "xai-oauth", forced: false });
    const gen = await run(generateImageTool, { prompt: "a fox" });
    expect(gen.isError).toBeFalsy();
    expect(fetchCalls[0]).toMatchObject({ url: "https://api.x.ai/v1/images/generations", opts: { headers: { Authorization: "Bearer xai-oauth" } } });
  });

  it("the other engine's sign-in stands in for a default engine that has only a key", async () => {
    creds = { xai: XAI_KEY, codex: CHATGPT };
    settingsBag = { provider: "anthropic", imageEngine: "grok" };
    expect(await resolveMediaProvider()).toEqual({
      provider: "codex", apiKey: TOKEN, forced: false, note: "Made with ChatGPT; Grok isn't connected.",
    });
  });
});

describe("while paid API keys are on, the keys work as before", () => {
  beforeEach(() => { settingsBag = { provider: "anthropic", allowPaidMediaApis: true }; });

  it("defaults, explicit backends, masked edits and video use the keys", async () => {
    expect(await resolveMediaProvider()).toEqual({ provider: "xai", apiKey: "xai-key", forced: false });
    expect(await resolveMediaProvider("openai")).toEqual({ provider: "openai", apiKey: "sk-api", forced: true });
    expect(await resolveMediaProvider(undefined, "video")).toEqual({ provider: "xai", apiKey: "xai-key", forced: false });
    const r = await run(editImageTool, { prompt: "x", image: SOURCE, mask: SOURCE });
    expect(r.isError).toBeFalsy();
    expect(fetchCalls[0]).toMatchObject({ url: "https://api.openai.com/v1/images/edits", opts: { headers: { Authorization: "Bearer sk-api" } } });
  });

  it("a sign-in still beats a key for the same engine", async () => {
    creds = { openai: OPENAI_KEY, codex: CHATGPT };
    settingsBag = { provider: "openai", allowPaidMediaApis: true };
    expect((await resolveMediaProvider()).provider).toBe("codex");
  });
});
