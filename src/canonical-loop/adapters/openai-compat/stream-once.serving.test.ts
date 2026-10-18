// A local chat request counts as in flight for exactly as long as it streams,
// so short-budget classifiers skip the model instead of queueing behind it
// (classify-with-llm-dispatch busy-skip, local-runtimes/residency.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();

vi.mock("../../../providers/adapters/openai-http.js", () => ({
  openaiHttpAdapter: { stream: streamMock },
}));

import { streamOnce } from "./stream-once.js";
import { isServingChat } from "../../../local-runtimes/residency.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";

function req(baseURL: string): ProviderRequest {
  return { apiKey: "k", model: "serving-model", baseURL, systemPrompt: "sys", messages: [{ role: "user", content: "hi" }], tools: [] };
}

beforeEach(() => streamMock.mockReset());

describe("streamOnce marks the local model as serving", () => {
  it("busy while the stream runs, idle once it ends", async () => {
    let busyMidStream: boolean | undefined;
    streamMock.mockImplementation(async function* () {
      busyMidStream = isServingChat("serving-model");
      yield { type: "text" as const, delta: "hello" };
      yield { type: "done" as const, stopReason: "stop" };
    });

    await streamOnce(req("http://127.0.0.1:11434/v1"), () => {}, { isAborted: () => false });

    expect(busyMidStream).toBe(true);
    expect(isServingChat("serving-model")).toBe(false);
  });

  it("a transport that throws still ends the request", async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: "text" as const, delta: "par" };
      throw new Error("socket closed");
    });

    const result = await streamOnce(req("http://127.0.0.1:11434/v1"), () => {}, { isAborted: () => false });

    expect(result.firstError?.code).toBe("transport_exception");
    expect(isServingChat("serving-model")).toBe(false);
  });

  it("a cloud endpoint is never counted — its queue is not this machine's", async () => {
    let busyMidStream: boolean | undefined;
    streamMock.mockImplementation(async function* () {
      busyMidStream = isServingChat("serving-model");
      yield { type: "done" as const, stopReason: "stop" };
    });

    await streamOnce(req("https://api.llm-cloud.example/v1"), () => {}, { isAborted: () => false });

    expect(busyMidStream).toBe(false);
  });
});
