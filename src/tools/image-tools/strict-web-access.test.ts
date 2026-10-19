// Strict web access refusing an image or video host is the shared allow-host
// block (status "blocked", clearable "allow-host", the host), so the chat
// offers "Allow <host> & retry" as it does for web_fetch, never a plain error.
// The real web-access policy judges every URL a media call dials (the initial
// destination check canonicalFetch runs before connecting); only the reply
// from an allowed host is stubbed, so nothing leaves the box.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig, ToolResult } from "../../types.js";

const PNG = Buffer.from("89504E470D0A1A0A0000000D49484452", "hex");
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const CODEX_TOKEN = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url")}.sig`;

let creds: Record<string, string | undefined> = {};
let settingsBag: Record<string, unknown> = {};
let reply: (url: string) => unknown = () => { throw new Error("no reply set"); };
const dialed: string[] = [];

vi.mock("../../auth/resolve.js", () => ({
  resolveCredential: async (provider: string) =>
    (creds[provider] ? { provider, credential: creds[provider], source: provider === "codex" ? "oauth" : "secrets-store" } : null),
}));
vi.mock("../../settings.js", async (orig) => ({
  ...(await orig<typeof import("../../settings.js")>()),
  loadSettings: () => ({ ...settingsBag }),
}));
vi.mock("../web-egress.js", async (orig) => {
  const real = await orig<typeof import("../web-egress.js")>();
  return {
    ...real,
    canonicalFetch: vi.fn(async (url: string) => {
      real.assertInitialEgressAllowed(url);
      dialed.push(url);
      return reply(url);
    }),
  };
});

const { generateImageTool } = await import("./generate-image.js");
const { editImageTool } = await import("./edit-image.js");
const { generateVideoTool } = await import("./generate-video.js");

let savedConfig: LAXConfig | undefined;
let savedLaxDir: string | undefined;
let laxDir = "";
let workspace = "";

function allow(...hosts: string[]): void {
  writeFileSync(join(laxDir, "egress-allowlist.json"), JSON.stringify(["allowed.example", ...hosts]));
}

beforeAll(() => {
  try { savedConfig = getRuntimeConfig(); } catch { savedConfig = undefined; }
  savedLaxDir = process.env.LAX_DATA_DIR;
  laxDir = mkdtempSync(join(tmpdir(), "lax-media-strict-"));
  workspace = mkdtempSync(join(tmpdir(), "lax-media-strict-ws-"));
  process.env.LAX_DATA_DIR = laxDir;
  writeFileSync(join(laxDir, "security.json"), JSON.stringify({ egressMode: "strict" }));
  setRuntimeConfig({ ...(savedConfig ?? {}), workspace } as unknown as LAXConfig);
});
afterAll(() => {
  if (savedConfig) setRuntimeConfig(savedConfig);
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = savedLaxDir;
  rmSync(laxDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});
beforeEach(() => {
  creds = {};
  settingsBag = { allowPaidMediaApis: true };
  dialed.length = 0;
  reply = () => { throw new Error("no reply set"); };
  allow();
});

type Result = ToolResult & { status?: string; metadata?: Record<string, unknown> };

function expectAllowHost(r: Result, host: string): void {
  expect(r.isError).toBe(true);
  expect(r.status).toBe("blocked");
  expect(r.metadata).toMatchObject({ layer: "security", clearable: "allow-host", host });
  expect(String(r.metadata?.recovery)).toContain(`allow ${host} from the notice in chat`);
}

describe("generate_image under strict web access", () => {
  it("xAI Grok Imagine on an unlisted api.x.ai is the allow-host block", async () => {
    creds = { xai: "xai-key" };
    expectAllowHost(await generateImageTool.execute({ prompt: "a fox", provider: "grok" }) as Result, "api.x.ai");
    expect(dialed).toEqual([]);
  });

  it("OpenAI DALL-E on an unlisted api.openai.com is the allow-host block", async () => {
    creds = { openai: "sk-api" };
    expectAllowHost(await generateImageTool.execute({ prompt: "a fox", provider: "openai" }) as Result, "api.openai.com");
  });

  it("the ChatGPT subscription on an unlisted chatgpt.com is the allow-host block", async () => {
    creds = { codex: CODEX_TOKEN };
    expectAllowHost(await generateImageTool.execute({ prompt: "a fox", provider: "chatgpt" }) as Result, "chatgpt.com");
  });

  it("an allowed provider that hands the image back from an unlisted host names that host", async () => {
    creds = { xai: "xai-key" };
    allow("api.x.ai");
    reply = () => ({ ok: true, status: 200, json: async () => ({ data: [{ url: "https://imgen.x.ai/out.png" }] }) });
    expectAllowHost(await generateImageTool.execute({ prompt: "a fox", provider: "grok" }) as Result, "imgen.x.ai");
    expect(dialed).toEqual(["https://api.x.ai/v1/images/generations"]);
  });

  it("the paid-media gate still answers first: a paid key while paid keys are off is refused, nothing dialed", async () => {
    creds = { openai: "sk-api" };
    settingsBag = { allowPaidMediaApis: false };
    const r = await generateImageTool.execute({ prompt: "a fox", provider: "openai" }) as Result;
    expect(r.isError).toBe(true);
    expect(r.status).toBeUndefined();
    expect(r.metadata?.clearable).toBeUndefined();
    expect(dialed).toEqual([]);
  });
});

describe("edit_image under strict web access", () => {
  it("xAI on an unlisted api.x.ai is the allow-host block", async () => {
    creds = { xai: "xai-key" };
    expectAllowHost(await editImageTool.execute({ prompt: "make it green", image: PNG_DATA_URL, provider: "grok" }) as Result, "api.x.ai");
  });

  it("OpenAI, prompt-only and masked, on an unlisted api.openai.com is the allow-host block", async () => {
    creds = { openai: "sk-api" };
    expectAllowHost(await editImageTool.execute({ prompt: "make it green", image: PNG_DATA_URL, provider: "openai" }) as Result, "api.openai.com");
    expectAllowHost(await editImageTool.execute({ prompt: "make it green", image: PNG_DATA_URL, mask: PNG_DATA_URL }) as Result, "api.openai.com");
  });

  it("the ChatGPT subscription on an unlisted chatgpt.com is the allow-host block", async () => {
    creds = { codex: CODEX_TOKEN };
    expectAllowHost(await editImageTool.execute({ prompt: "make it green", image: PNG_DATA_URL, provider: "chatgpt" }) as Result, "chatgpt.com");
  });

  it("a source image on an unlisted host is the allow-host block for that host", async () => {
    creds = { xai: "xai-key" };
    expectAllowHost(await editImageTool.execute({ prompt: "make it green", image: "https://pics.example.net/a.png", provider: "grok" }) as Result, "pics.example.net");
  });
});

describe("generate_video under strict web access", () => {
  it("xAI Grok Imagine video on an unlisted api.x.ai is the allow-host block", async () => {
    creds = { xai: "xai-key" };
    expectAllowHost(await generateVideoTool.execute({ prompt: "a fox running", provider: "grok" }) as Result, "api.x.ai");
    expect(dialed).toEqual([]);
  });
});
