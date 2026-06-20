/**
 * Inbound Telegram media must be handed to the agent as a SERVED /uploads URL,
 * not a raw local path. A local path can't be fetched by generate_video/
 * generate_image (xAI side) and trips the attachment-egress gate — the
 * regression that broke "turn this Telegram photo into a video". Web/mobile and
 * the image/video tools already use the /uploads URL form; this locks Telegram
 * to the same convention so it can't silently revert to "Saved locally at …".
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../bridge-voice/index.js", () => ({}));
vi.mock("../voice/index.js", () => ({}));
vi.mock("../config.js", () => ({ getRuntimeConfig: () => ({ port: 7007 }) }));
vi.mock("./api.js", () => ({
  downloadTelegramFile: vi.fn(async (_t: string, _f: string, kind: string) => `/Users/x/.lax/uploads/tg-${kind}-123.jpg`),
  apiCall: vi.fn(),
  sendMessage: vi.fn(),
  sendVoice: vi.fn(),
}));

import { describeNonTextMessage } from "./inbound.js";

describe("describeNonTextMessage — inbound media is a served /uploads URL", () => {
  it("presents a photo as http://127.0.0.1:<port>/uploads/<file> for media tools", async () => {
    const out = await describeNonTextMessage({ photo: [{ file_id: "f1", width: 100, height: 100 }] }, "tok");
    expect(out).toContain("http://127.0.0.1:7007/uploads/tg-photo-123.jpg");
    expect(out).toMatch(/pass THIS to media tools/i);
  });

  it("keeps the local path too (for transcription / OCR that read the file directly)", async () => {
    const out = await describeNonTextMessage({ document: { file_id: "f2", mime_type: "application/pdf", file_name: "x.pdf" } }, "tok");
    expect(out).toContain("http://127.0.0.1:7007/uploads/tg-document-123.jpg");
    expect(out).toContain("/Users/x/.lax/uploads/tg-document-123.jpg");
  });

  it("returns empty for a message with no media", async () => {
    expect(await describeNonTextMessage({ text: "hi" }, "tok")).toBe("");
  });
});
