// A `content_filter` finish on the OpenAI-compat wire ends the turn with no
// text; it must reach the chat as an error, the same as the Anthropic
// `refusal` stop (model-stop.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();

vi.mock("../../../providers/adapters/openai-http.js", () => ({
  openaiHttpAdapter: { stream: streamMock },
}));
vi.mock("../../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(() => ({ tokens: 1_000_000, provenance: "probed" as const })),
}));
vi.mock("../../../providers/types.js", () => ({
  markNoToolSupport: vi.fn(),
}));
vi.mock("../../../providers/tool-capability-probe.js", () => ({
  noteLiveToolCallEvidence: vi.fn(),
  maybeVerifyToolSupport: vi.fn(async () => {}),
}));

import { streamOnce } from "./stream-once.js";
import type { AdapterReport } from "../../adapter-contract.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";

function req(): ProviderRequest {
  return { apiKey: "k", model: "test-model", baseURL: "https://api.llm-cloud.example/v1", systemPrompt: "sys", messages: [{ role: "user", content: "hi" }], tools: [] };
}

beforeEach(() => { streamMock.mockReset(); });

describe("streamOnce refusal handling", () => {
  it("content_filter with no text becomes a non-retryable model_refusal error", async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: "done" as const, stopReason: "content_filter" };
    });
    const reports: AdapterReport[] = [];
    const result = await streamOnce(req(), (r) => reports.push(r), { isAborted: () => false });
    expect(result.firstError?.code).toBe("model_refusal");
    expect(reports).toContainEqual({ kind: "error", code: "model_refusal", message: result.firstError?.message, retryable: false });
  });

  it("a plain stop stays clean", async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: "text" as const, delta: "hello" };
      yield { type: "done" as const, stopReason: "stop" };
    });
    const reports: AdapterReport[] = [];
    const result = await streamOnce(req(), (r) => reports.push(r), { isAborted: () => false });
    expect(result.firstError).toBeNull();
    expect(reports.some((r) => r.kind === "error")).toBe(false);
  });
});
