// The ChatGPT Codex backend's image routes, as the Codex CLI calls them
// (openai/codex codex-rs/codex-api/src/endpoint/images.rs): JSON in, one JSON
// object with base64 images out.
import { describe, expect, it } from "vitest";
import { buildCodexImageRequest, readCodexImageResponse, CODEX_IMAGE_MODEL } from "./images.js";
import { buildHeaders } from "./request.js";

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}
const TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });

describe("buildCodexImageRequest", () => {
  it("generates on <base>/images/generations with the Codex CLI's body", () => {
    const req = buildCodexImageRequest(TOKEN, "a red fox");
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(JSON.parse(req.body)).toEqual({
      prompt: "a red fox", background: "opaque", model: CODEX_IMAGE_MODEL, quality: "auto", size: "auto",
    });
    expect(CODEX_IMAGE_MODEL).toBe("gpt-image-2");
  });

  it("edits on <base>/images/edits, each input image as { image_url }", () => {
    const req = buildCodexImageRequest(TOKEN, "add a hat", ["data:image/png;base64,Zm9v"]);
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(req.body)).toMatchObject({
      prompt: "add a hat", model: CODEX_IMAGE_MODEL, images: [{ image_url: "data:image/png;base64,Zm9v" }],
    });
  });

  it("carries the subscription identity the chat route sends, and asks for JSON, not a stream", () => {
    const { headers } = buildCodexImageRequest(TOKEN, "x");
    const chat = buildHeaders(TOKEN);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
    expect(headers.originator).toBe(chat.originator);
    expect(headers["User-Agent"]).toBe(chat["User-Agent"]);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(headers["OpenAI-Beta"]).toBeUndefined();
  });

  it("keeps the token out of the URL and the body", () => {
    const req = buildCodexImageRequest(TOKEN, "x", ["data:image/png;base64,Zm9v"]);
    expect(req.url).not.toContain(TOKEN);
    expect(req.body).not.toContain(TOKEN);
  });
});

describe("readCodexImageResponse", () => {
  it("returns the first image's base64", () => {
    expect(readCodexImageResponse({ created: 1, data: [{ b64_json: "QUJD" }, { b64_json: "REVG" }] })).toBe("QUJD");
  });

  it("returns null when the reply carries no image", () => {
    for (const json of [null, {}, { data: [] }, { data: [{ b64_json: "" }] }, { data: [{ url: "https://x" }] }]) {
      expect(readCodexImageResponse(json)).toBeNull();
    }
  });
});
