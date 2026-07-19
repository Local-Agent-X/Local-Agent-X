import { afterEach, describe, expect, it, vi } from "vitest";
import { localCertificationTransport } from "./certification-transport.js";

afterEach(() => vi.unstubAllGlobals());

describe("local certification transport response bound", () => {
  it("cancels a streaming response as soon as it exceeds 64 KiB", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
      },
      cancel() { cancelled += 1; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    const result = await localCertificationTransport({
      endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
      kind: "openai-compat",
      model: "m",
      body: {},
      signal: new AbortController().signal,
    });
    expect(result.body).toBeNull();
    expect(cancelled).toBe(1);
  });
});

