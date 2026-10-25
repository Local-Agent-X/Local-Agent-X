/**
 * An image the runtime cannot load costs the image, never the turn: on
 * 2026-10-25 a hand-made PNG opened with view_image made Ollama refuse the
 * request ("Failed to load image or audio file") and the op ended mid-task.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AdapterReport } from "../../adapter-contract.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";
import type { StreamOnceResult } from "./types.js";
import { isImageRejection, sendLeavingOutUnreadableImages } from "./unreadable-images.js";

const OLLAMA_REFUSAL = "400 Failed to load image or audio file";

const imageMessage = (url: string): ChatCompletionMessageParam => ({
  role: "user",
  content: [{ type: "text", text: "[Tool returned 1 image]" }, { type: "image_url", image_url: { url } }],
});
const request = (...urls: string[]): ProviderRequest => ({
  apiKey: "", model: "qwen3.8:27b", systemPrompt: "",
  messages: [{ role: "user", content: "read the gcode" }, ...urls.map(imageMessage)],
} as unknown as ProviderRequest);

const result = (error?: string): StreamOnceResult => ({
  assembledText: error ? "" : "ok", assembledThinking: "", pendingToolCalls: [], providerStop: error ? undefined : "stop",
  firstError: error ? { code: "transport_error", message: error } : null,
  usagePromptTokens: undefined, usageCompletionTokens: undefined, interruptedByInject: false, stoppedByGuard: undefined,
} as StreamOnceResult);

/** A runtime that refuses any request carrying one of `bad`. */
function runtime(bad: string[]) {
  const sent: ProviderRequest[] = [];
  const send = vi.fn(async (req: ProviderRequest, report: (r: AdapterReport) => void) => {
    sent.push(req);
    const urls = JSON.stringify(req.messages);
    if (bad.some((u) => urls.includes(u))) {
      report({ kind: "error", code: "transport_error", message: OLLAMA_REFUSAL, retryable: false });
      return result(OLLAMA_REFUSAL);
    }
    return result();
  });
  return { send, sent };
}

const urlsIn = (req: ProviderRequest) => JSON.stringify(req.messages).match(/data:image\/png;base64,\w+/g) ?? [];

describe("isImageRejection", () => {
  it("matches the runtimes' cannot-load-this-image refusals", () => {
    for (const m of [OLLAMA_REFUSAL, "cannot identify image file <_io.BytesIO>", "Invalid image data", "image could not be decoded"]) {
      expect(isImageRejection(m), m).toBe(true);
    }
  });

  it("leaves every other error alone", () => {
    for (const m of ["context length exceeded", "429 rate limited", "model not found", undefined]) expect(isImageRejection(m)).toBe(false);
  });
});

describe("sendLeavingOutUnreadableImages", () => {
  const good = "data:image/png;base64,GOOD";
  const broken = "data:image/png;base64,BROKEN";

  it("leaves out the refused newest image, tells the model, and the turn goes on", async () => {
    const { send, sent } = runtime([broken]);
    const report = vi.fn();
    const out = await sendLeavingOutUnreadableImages(request(good, broken), report, send, new Set());
    expect(out.firstError).toBeNull();
    expect(urlsIn(sent[1])).toEqual([good]);
    expect(JSON.stringify(sent[1].messages)).toContain("could not be read by the model runtime");
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  it("never sends a refused image again on a later turn", async () => {
    const { send, sent } = runtime([broken]);
    const unreadable = new Set<string>();
    await sendLeavingOutUnreadableImages(request(good, broken), vi.fn(), send, unreadable);
    send.mockClear(); sent.length = 0;
    await sendLeavingOutUnreadableImages(request(good, broken, "data:image/png;base64,NEW"), vi.fn(), send, unreadable);
    expect(send).toHaveBeenCalledTimes(1);
    expect(urlsIn(sent[0])).not.toContain(broken);
  });

  it("when leaving out the newest is not enough, leaves out every image", async () => {
    const { send, sent } = runtime([good]);
    const out = await sendLeavingOutUnreadableImages(request(good, broken), vi.fn(), send, new Set());
    expect(out.firstError).toBeNull();
    expect(urlsIn(sent[sent.length - 1])).toEqual([]);
  });

  it("any other error is reported as before, with no retry", async () => {
    const send = vi.fn(async (_req: ProviderRequest, report: (r: AdapterReport) => void) => {
      report({ kind: "error", code: "transport_error", message: "429 rate limited", retryable: false });
      return result("429 rate limited");
    });
    const report = vi.fn();
    const out = await sendLeavingOutUnreadableImages(request(broken), report, send, new Set());
    expect(send).toHaveBeenCalledTimes(1);
    expect(out.firstError?.message).toBe("429 rate limited");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: "429 rate limited" }));
  });
});
