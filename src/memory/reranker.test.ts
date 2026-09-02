import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { rerankWithLLM } from "./reranker.js";
import type { MemorySearchResult } from "./index.js";

// Regression lock: the reranker's Ollama call must derive its URL from
// config.ollamaUrl, not a hardcoded localhost:11434. It shipped hardcoded,
// so a user pointing LAX_OLLAMA_URL at a non-default host got working chat
// but silently broken reranking (fetch to a dead port returns [], and the
// reranker degrades quietly by design).
vi.mock("../config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:9999/" }),
}));

// The Anthropic leg rides the canonical dispatch (llm-dispatch → hosted.js
// callAnthropic). Credential resolution and the canonical anthropic client are
// mocked so the tests can pick the auth scheme and assert the wire shape.
const mocks = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  streamAnthropicResponse: vi.fn(),
}));
vi.mock("../auth/resolve.js", () => ({ resolveCredential: mocks.resolveCredential }));
vi.mock("../anthropic-client/index.js", () => ({ streamAnthropicResponse: mocks.streamAnthropicResponse }));

function result(snippet: string): MemorySearchResult {
  return { snippet, score: 0.5 } as MemorySearchResult;
}

describe("rerankWithLLM ollama URL comes from config (fetch stubbed — no network)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ response: "[8, 2]" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls config.ollamaUrl (trailing slash stripped), never hardcoded localhost:11434", async () => {
    const out = await rerankWithLLM("q", [result("a"), result("b")], { provider: "ollama" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:9999/api/generate");
    // Scores applied → reranked ordering preserved with blended scores.
    expect(out).toHaveLength(2);
  });
});

// Regression locks for the two raw-fetch bypasses the Anthropic leg used to
// have (it forked callAnthropic and drifted):
//   1. `oauth:` (subscription) credentials were sent as a Bearer header on a
//      direct fetch to api.anthropic.com — the banned path (429 since April
//      2026). They must route through the canonical anthropic client instead.
//   2. temperature:0 was hardcoded — adaptive-thinking models (Fable 5 & co.)
//      reject any temperature with a 400, nulling every rerank.
// Now the leg rides dispatch(), so both invariants come from the one canonical
// wire in llm-dispatch/hosted.js.
describe("rerankWithLLM anthropic leg rides the canonical dispatch (fetch stubbed — no network)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ text: "[8, 2]" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    mocks.resolveCredential.mockResolvedValue({ credential: "sk-ant-api-test" });
    mocks.streamAnthropicResponse.mockImplementation(async function* () {
      yield { type: "text", delta: "[8, 2]" };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function sentBody(): Record<string, unknown> {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>;
  }

  it("API key + legacy snapshot alias: x-api-key header (never Bearer), NORMALIZED model, temperature 0", async () => {
    const out = await rerankWithLLM("q", [result("a"), result("b")], { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-api-test");
    expect(init.headers.Authorization).toBeUndefined();
    const body = sentBody();
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(200);
    expect(out).toHaveLength(2);
  });

  it("API key + adaptive model: wire body carries NO temperature (Fable 5 400s on it)", async () => {
    await rerankWithLLM("q", [result("a"), result("b")], { provider: "anthropic", model: "claude-fable-5" });
    const body = sentBody();
    expect(body.model).toBe("claude-fable-5");
    expect("temperature" in body).toBe(false);
  });

  it("no model pinned: defaults to the registry background model on the wire", async () => {
    await rerankWithLLM("q", [result("a"), result("b")], { provider: "anthropic" });
    expect(sentBody().model).toBe("claude-haiku-4-5");
  });

  it("oauth: credential NEVER touches the raw wire — routed through the canonical client, token unstripped", async () => {
    mocks.resolveCredential.mockResolvedValue({ credential: "oauth:sub-token" });
    const out = await rerankWithLLM("q", [result("a"), result("b")], { provider: "anthropic" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.streamAnthropicResponse).toHaveBeenCalledTimes(1);
    // Unstripped: the client's own usesAnthropicSubscriptionAuth needs the
    // oauth: shape intact to pick the CLI-proxy transport.
    const opts = mocks.streamAnthropicResponse.mock.calls[0][0] as { token: string };
    expect(opts.token).toBe("oauth:sub-token");
    // Proxied reply's scores were applied.
    expect(out).toHaveLength(2);
    expect(out[0].score).not.toBe(0.5);
  });

  it("no credential at all: no fetch, no client call, original results returned unchanged (no provider fallback)", async () => {
    mocks.resolveCredential.mockResolvedValue(null);
    const input = [result("a"), result("b")];
    const out = await rerankWithLLM("q", input, { provider: "anthropic" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.streamAnthropicResponse).not.toHaveBeenCalled();
    expect(out).toEqual(input);
  });
});
