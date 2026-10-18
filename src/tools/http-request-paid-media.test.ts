// http_request is not a way around the Settings → Media switch: while paid API
// keys for images and video are off, a stored secret sent to a provider's image
// or video route is refused before anything is resolved or sent. Other routes
// of the same provider, and the call with the switch on, go through.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sent = vi.hoisted(() => ({ calls: [] as string[], settings: {} as Record<string, unknown> }));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: async (url: unknown) => {
      sent.calls.push(String(url));
      const h = new Map([["content-type", "application/json"]]);
      return {
        status: 200, statusText: "OK", ok: true,
        headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null, forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)) },
        text: async () => '{"ok":true}',
      };
    },
  };
});
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({ requestApprovalDetailed: async () => ({ approved: true }) }),
}));
vi.mock("../ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => new Set<string>() }));
vi.mock("../settings.js", async (orig) => ({ ...(await orig<typeof import("../settings.js")>()), loadSettings: () => sent.settings }));

const { createHttpRequestTool } = await import("./http-request.js");
const { SecretsStore } = await import("../secrets.js");

let dir: string;
let store: InstanceType<typeof SecretsStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-http-paid-media-"));
  store = new SecretsStore(dir);
  store.set("XAI_API_KEY", "xai-" + "k".repeat(40), { service: "xAI" });
  store.set("OPENAI_API_KEY", "sk-" + "o".repeat(40), { service: "OpenAI" });
  sent.calls.length = 0;
  sent.settings = {};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (url: string, secret: string) =>
  createHttpRequestTool(store).execute({
    _sessionId: "chat-1", _toolCallId: "tc-1", _onEvent: () => undefined,
    url, method: "POST", headers: { Authorization: `Bearer {{${secret}}}`, "Content-Type": "application/json" }, body: '{"prompt":"a fox"}',
  });

describe("http_request to a paid image or video route", () => {
  it("is refused while paid API keys are off, naming the setting", async () => {
    const image = await call("https://api.openai.com/v1/images/generations", "OPENAI_API_KEY");
    expect(image).toMatchObject({ isError: true });
    expect(image.content).toContain("Paid API image generation is off — turn on 'Allow paid API keys for images and video' in Settings → Media.");
    const video = await call("https://api.x.ai/v1/videos/generations", "XAI_API_KEY");
    expect(video.content).toContain("Paid API video generation is off");
    expect(sent.calls).toEqual([]);
  });

  it("goes through with the switch on", async () => {
    sent.settings = { allowPaidMediaApis: true };
    const r = await call("https://api.x.ai/v1/images/generations", "XAI_API_KEY");
    expect(r.isError).toBeFalsy();
    expect(sent.calls).toEqual(["https://api.x.ai/v1/images/generations"]);
  });

  it("leaves the provider's other routes alone", async () => {
    const r = await call("https://api.x.ai/v1/chat/completions", "XAI_API_KEY");
    expect(r.isError).toBeFalsy();
    expect(sent.calls).toEqual(["https://api.x.ai/v1/chat/completions"]);
  });
});
