// The ChatGPT-subscription (`codex`) media backend: which calls reach it, what
// they send, what comes back, and that a refusal is an error naming ChatGPT,
// never a quiet switch to another provider. The network is mocked throughout.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FormData, Request } from "undici";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig, ToolResult } from "../../types.js";

const PNG = Buffer.from("89504E470D0A1A0A0000000D49484452", "hex");
const PNG_B64 = PNG.toString("base64");
const TOKEN = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url")}.sig`;

let creds: Record<string, string | undefined> = {};
let settingsBag: Record<string, unknown> = {};
type Reply = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> };
let reply: (url: string) => Reply | Promise<Reply>;
const fetchCalls: Array<{ url: string; opts: { method?: string; headers?: Record<string, string>; body?: unknown } }> = [];

vi.mock("../../auth/resolve.js", () => ({
  resolveCredential: async (provider: string) => (creds[provider] ? { provider, credential: creds[provider], source: "oauth" } : null),
}));
vi.mock("../../settings.js", async (orig) => ({ ...(await orig<typeof import("../../settings.js")>()), loadSettings: () => settingsBag }));
vi.mock("../web-egress.js", async (orig) => ({
  ...(await orig<typeof import("../web-egress.js")>()),
  canonicalFetch: vi.fn(async (url: string, opts: (typeof fetchCalls)[number]["opts"] = {}) => {
    fetchCalls.push({ url, opts });
    return reply(url);
  }),
}));

const { generateImageTool } = await import("./generate-image.js");
const { editImageTool } = await import("./edit-image.js");
const { resolveMediaProvider } = await import("./shared.js");
const { EgressRedirectBlocked } = await import("../web-egress.js");

function jsonReply(status: number, body: unknown): Reply {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
  };
}
const imageReply = () => jsonReply(200, { created: 1, data: [{ b64_json: PNG_B64 }] });
type Result = ToolResult & { _image?: { path: string; b64: string }; status?: string; metadata?: Record<string, unknown> };

let saved: LAXConfig | undefined;
let workspace = "";
beforeAll(() => {
  try { saved = getRuntimeConfig(); } catch { saved = undefined; }
  workspace = mkdtempSync(join(tmpdir(), "lax-codex-img-"));
  setRuntimeConfig({ ...(saved ?? {}), workspace } as unknown as LAXConfig);
});
afterAll(() => {
  if (saved) setRuntimeConfig(saved);
  rmSync(workspace, { recursive: true, force: true });
});
beforeEach(() => {
  creds = { codex: TOKEN };
  settingsBag = { provider: "codex" };
  fetchCalls.length = 0;
  reply = imageReply;
});

describe("which backend an image call resolves to", () => {
  it("an explicit 'chatgpt' or 'codex' picks the subscription, forced", async () => {
    creds = { codex: TOKEN, xai: "xai-key", openai: "sk-api" };
    for (const name of ["chatgpt", "codex", "ChatGPT"]) {
      expect(await resolveMediaProvider(name)).toEqual({ provider: "codex", apiKey: TOKEN, forced: true });
    }
  });

  it("an explicit 'openai' stays the API key even when ChatGPT is signed in", async () => {
    creds = { codex: TOKEN, openai: "sk-api" };
    expect(await resolveMediaProvider("openai")).toEqual({ provider: "openai", apiKey: "sk-api", forced: true });
  });

  it("an active ChatGPT chat provider resolves to the subscription", async () => {
    expect(await resolveMediaProvider()).toEqual({ provider: "codex", apiKey: TOKEN, forced: false });
  });

  it("an active OpenAI provider prefers the subscription over the API key, and keeps the key without one", async () => {
    settingsBag = { provider: "openai" };
    creds = { codex: TOKEN, openai: "sk-api" };
    expect((await resolveMediaProvider()).provider).toBe("codex");
    creds = { openai: "sk-api" };
    expect(await resolveMediaProvider()).toEqual({ provider: "openai", apiKey: "sk-api", forced: false });
  });
});

describe("generate_image on the ChatGPT subscription", () => {
  it("posts the Codex image request and saves the returned PNG where the other backends do", async () => {
    const r = await generateImageTool.execute({ prompt: "a red fox" }) as Result;
    expect(r.isError).toBeFalsy();
    expect(fetchCalls).toHaveLength(1);
    const { url, opts } = fetchCalls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(opts.method).toBe("POST");
    expect(opts.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opts.headers?.["chatgpt-account-id"]).toBe("acct_9");
    expect(JSON.parse(String(opts.body))).toMatchObject({ prompt: "a red fox", model: "gpt-image-2" });

    const savePath = r.content.match(/Saved: (.+)/)?.[1];
    expect(savePath && resolve(savePath).startsWith(resolve(workspace, "images"))).toBe(true);
    expect(readFileSync(savePath!)).toEqual(PNG);
    expect(r.content).toMatch(/View: \/images\/chatgpt_\d+\.png/);
    expect(r._image?.path).toBe(savePath);
    expect(r._image?.b64).toBe(PNG_B64);
    expect(r.content).not.toContain(TOKEN);
  });

  it("a refusal is an error naming ChatGPT, with no second call to another backend", async () => {
    creds = { codex: TOKEN, openai: "sk-api" };
    for (const [status, hint] of [[403, /sign in again/], [429, /limit/], [404, /no longer offered/]] as const) {
      fetchCalls.length = 0;
      reply = () => jsonReply(status, { error: { message: "nope" } });
      const r = await generateImageTool.execute({ prompt: "x", provider: "chatgpt" }) as Result;
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(new RegExp(`ChatGPT image generation failed \\(${status}\\)`));
      expect(r.content).toMatch(hint);
      expect(r.content).not.toContain(TOKEN);
      expect(fetchCalls.map(c => c.url)).toEqual(["https://chatgpt.com/backend-api/codex/images/generations"]);
    }
  });

  it("a reply with no image is an error, not an empty file", async () => {
    reply = () => jsonReply(200, { created: 1, data: [] });
    const r = await generateImageTool.execute({ prompt: "x" }) as Result;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/ChatGPT returned no image/);
  });

  it("strict web access refusing the host comes back as the allow-host block", async () => {
    reply = (url) => { throw new EgressRedirectBlocked(url, "Blocked: chatgpt.com is not on the web access allowlist (strict mode).", { kind: "allow-host", host: "chatgpt.com" }); };
    const r = await generateImageTool.execute({ prompt: "x" }) as Result;
    expect(r.status).toBe("blocked");
    expect(r.metadata).toMatchObject({ clearable: "allow-host", host: "chatgpt.com" });
  });

  it("a forced ChatGPT with no sign-in says so instead of falling back", async () => {
    creds = { openai: "sk-api" };
    const r = await generateImageTool.execute({ prompt: "x", provider: "chatgpt" }) as Result;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/ChatGPT \(subscription sign-in\) isn't connected/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("an active OpenAI provider with no ChatGPT sign-in keeps the API-key path", async () => {
    settingsBag = { provider: "openai" };
    creds = { openai: "sk-api" };
    reply = (url) => url.includes("/images/generations")
      ? jsonReply(200, { data: [{ url: "https://cdn.example.com/out.png" }] })
      : imageReply();
    const r = await generateImageTool.execute({ prompt: "x" }) as Result;
    expect(r.isError).toBeFalsy();
    expect(fetchCalls[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(fetchCalls[0].opts.headers?.Authorization).toBe("Bearer sk-api");
  });
});

describe("edit_image on the ChatGPT subscription", () => {
  const SOURCE = `data:image/png;base64,${PNG_B64}`;

  it("sends the source image as a data URL and saves the edit", async () => {
    const r = await editImageTool.execute({ prompt: "add a hat", image: SOURCE }) as Result;
    expect(r.isError).toBeFalsy();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    const body = JSON.parse(String(fetchCalls[0].opts.body));
    expect(body.images).toEqual([{ image_url: SOURCE }]);
    expect(body.prompt).toBe("add a hat");
    const savePath = r.content.match(/Saved: (.+)/)?.[1];
    expect(savePath && existsSync(savePath)).toBe(true);
    expect(r.content).toMatch(/View: \/images\/edit_\d+\.png/);
    expect(r.content).toMatch(/via ChatGPT/);
  });

  it("a mask forced onto ChatGPT is refused, since the route takes none", async () => {
    const r = await editImageTool.execute({ prompt: "x", image: SOURCE, mask: SOURCE, provider: "chatgpt" }) as Result;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no mask support/);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("edit_image on the OpenAI API key", () => {
  it("goes through canonicalFetch with an undici multipart body", async () => {
    creds = { openai: "sk-api" };
    settingsBag = { provider: "openai" };
    const r = await editImageTool.execute({ prompt: "x", image: `data:image/png;base64,${PNG_B64}` }) as Result;
    expect(r.isError).toBeFalsy();
    expect(fetchCalls[0].url).toBe("https://api.openai.com/v1/images/edits");
    const body = fetchCalls[0].opts.body;
    expect(body).toBeInstanceOf(FormData);
    // The fetch canonicalFetch uses serializes this body as multipart.
    const req = new Request("https://api.openai.com/v1/images/edits", { method: "POST", body: body as FormData });
    expect(req.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
  });
});
