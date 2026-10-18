// The OpenAI path used to save under a cwd-relative "workspace/generated" and
// print a "/uploads/../workspace/generated/<file>" URL that no route serves.
// It now saves where the xAI path does — the canonical workspace images/ dir
// the /images/<file> mount serves from — and returns that URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig } from "../../types.js";

const PNG_1x1 = Buffer.from(
  "89504E470D0A1A0A0000000D4948445200000001000000010806000000" +
  "1F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

vi.mock("../../auth/resolve.js", () => ({ resolveCredential: async () => ({ credential: "test-key", source: "secrets-store" }) }));
// The OpenAI API key is a paid key: allowed here (Settings → Media switch on).
vi.mock("../../settings.js", async (orig) => ({
  ...(await orig<typeof import("../../settings.js")>()),
  loadSettings: () => ({ allowPaidMediaApis: true }),
}));
vi.mock("../web-egress.js", () => ({
  canonicalFetch: async (url: string) => {
    if (url.includes("/images/generations")) {
      return { ok: true, json: async () => ({ data: [{ url: "https://cdn.example.com/out.png" }] }) };
    }
    return { ok: true, arrayBuffer: async () => PNG_1x1.buffer.slice(PNG_1x1.byteOffset, PNG_1x1.byteOffset + PNG_1x1.byteLength) };
  },
}));

const { generateImageTool } = await import("./generate-image.js");

let saved: LAXConfig | undefined;
let workspace = "";

beforeAll(() => {
  try { saved = getRuntimeConfig(); } catch { saved = undefined; }
  workspace = mkdtempSync(join(tmpdir(), "lax-genimg-"));
  setRuntimeConfig({ ...(saved ?? {}), workspace } as unknown as LAXConfig);
});
afterAll(() => {
  if (saved) setRuntimeConfig(saved);
  rmSync(workspace, { recursive: true, force: true });
});

describe("generate_image via OpenAI", () => {
  it("saves under the workspace images/ dir and returns the served /images URL", async () => {
    const r = await generateImageTool.execute({ prompt: "a red square", provider: "openai" }) as { content: string; isError?: boolean; _image?: { path: string } };
    expect(r.isError).toBeFalsy();
    const savePath = r.content.match(/Saved: (.+)/)?.[1];
    expect(savePath).toBeTruthy();
    expect(resolve(savePath!).startsWith(resolve(workspace, "images"))).toBe(true);
    expect(existsSync(savePath!)).toBe(true);
    expect(r.content).toMatch(/View: \/images\/dalle_\d+\.png/);
    expect(r.content).not.toContain("/uploads/..");
    expect(r._image?.path).toBe(savePath);
  });
});
