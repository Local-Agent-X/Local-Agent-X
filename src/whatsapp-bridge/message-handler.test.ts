/**
 * Inbound WhatsApp media must reach the model, not vanish. Before this path,
 * message-handler only extracted text/caption: an uncaptioned photo/doc was
 * dead silence and a captioned one forwarded the caption with no hint an image
 * existed. describeInboundMedia downloads the bytes to ~/.lax/uploads and hands
 * the agent a served /uploads URL + local path (mirroring the Telegram path).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the module lightweight — the handler statically imports voice-reply,
// which pulls the voice/STT stack we don't exercise here.
vi.mock("../bridge-voice/index.js", () => ({}));
vi.mock("../voice/index.js", () => ({}));
vi.mock("./voice-reply.js", () => ({
  markVoiceMirror: vi.fn(),
  clearVoiceMirror: vi.fn(),
  dispatchReplyToJid: vi.fn(),
}));

const UPLOADS = mkdtempSync(join(tmpdir(), "wa-media-test-"));

const downloadMediaMessage = vi.fn(async () => Buffer.from("fake-media-bytes"));
vi.mock("@whiskeysockets/baileys", () => ({ downloadMediaMessage }));
vi.mock("../config.js", () => ({
  uploadsDir: () => UPLOADS,
  getRuntimeConfig: () => ({ port: 7007 }),
}));

import { createMessagesUpsertHandler, describeInboundMedia } from "./message-handler.js";

describe("describeInboundMedia — inbound media reaches the model", () => {
  beforeEach(() => downloadMediaMessage.mockClear());

  it("returns '' for a plain text message (no media to forward)", async () => {
    expect(await describeInboundMedia({ message: { conversation: "hi" } })).toBe("");
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it("downloads an UNCAPTIONED photo and hands back a served /uploads URL (was dead silence)", async () => {
    const out = await describeInboundMedia({ message: { imageMessage: { mimetype: "image/jpeg" } } });
    expect(out).toMatch(/http:\/\/127\.0\.0\.1:7007\/uploads\/wa-image-\d+\.jpeg/);
    expect(out).toMatch(/pass THIS to media tools/i);
    // Bytes actually landed in uploads/ (a filename the /uploads route accepts).
    const written = readdirSync(UPLOADS).filter((f) => f.startsWith("wa-image-"));
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((f) => /^[a-zA-Z0-9._-]+$/.test(f))).toBe(true);
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
  });

  it("includes the caption AND flags that an image exists (was: caption only, no hint)", async () => {
    const out = await describeInboundMedia({ message: { imageMessage: { mimetype: "image/png", caption: "look at this" } } });
    expect(out).toContain('Caption: "look at this"');
    expect(out).toMatch(/User sent a image message via WhatsApp/);
  });

  it("handles a document, preferring the filename extension for the served path", async () => {
    const out = await describeInboundMedia({ message: { documentMessage: { mimetype: "application/pdf", fileName: "report.pdf" } } });
    expect(out).toMatch(/\/uploads\/wa-document-\d+\.pdf/);
    expect(out).toContain("report.pdf");
  });

  it("reports a download failure instead of silently dropping the message", async () => {
    downloadMediaMessage.mockRejectedValueOnce(new Error("boom"));
    const out = await describeInboundMedia({ message: { videoMessage: { mimetype: "video/mp4" } } });
    expect(out).toContain("download failed: boom");
  });
});

describe("WhatsApp inbound identity", () => {
  it("forwards the stable provider message id to the canonical inbound runner", async () => {
    const onMessage = vi.fn().mockResolvedValue(null);
    const handler = createMessagesUpsertHandler({
      phoneNumber: "15550001",
      selfLid: null,
      allowedNumbers: new Set(),
      processedMessages: new Set(),
      processingLock: new Set(),
      sock: { readMessages: vi.fn(), sendPresenceUpdate: vi.fn().mockResolvedValue(undefined) },
      onMessage,
      sendMessage: vi.fn().mockResolvedValue(true),
      sendToJid: vi.fn().mockResolvedValue(true),
      sendVoiceToJid: vi.fn().mockResolvedValue(true),
    }, null);
    await handler({ type: "notify", messages: [{
      key: { id: "ABC123", remoteJid: "15550001@s.whatsapp.net", fromMe: false },
      pushName: "Peter",
      message: { conversation: "hello" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }] });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "wa-15550001",
      deliveryId: "message:ABC123",
    }));
  });
});
