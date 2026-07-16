import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { LocalRuntimeInfo } from "./local-runtimes/types.js";

// Which Ollama models this box "has installed". dispatch() must read this
// rather than a pinned id — a hardcoded default 404s on every box that
// didn't happen to pull it (regression: "llama3:8b", April–July 2026).
let localRuntimes: LocalRuntimeInfo[] | null = null;

vi.mock("./local-runtimes/index.js", () => ({
  getLocalRuntimes: () => localRuntimes,
  refreshLocalRuntimes: vi.fn(async () => localRuntimes ?? []),
}));

import { dispatch, dispatchBackgroundModel, dispatchStructuredOutputEnabled } from "./llm-dispatch.js";
import { resolveCredential } from "./auth/resolve.js";
import { streamAnthropicResponse } from "./anthropic-client/index.js";
import { backgroundModelFor, PROVIDERS } from "./providers/registry.js";

function ollamaRuntime(models: LocalRuntimeInfo["models"]): LocalRuntimeInfo {
  return {
    kind: "ollama",
    id: "ollama@127.0.0.1:11434",
    label: "Ollama",
    endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
    chatBaseUrl: "http://127.0.0.1:11434/v1",
    models,
    refreshedAt: 1,
  };
}

const INSTALLED = ollamaRuntime([
  { id: "gpt-oss:120b", contextWindow: null, tools: true, sizeBytes: 65e9 },
  { id: "qwen3.6:27b", contextWindow: null, tools: true, sizeBytes: 17e9 },
  { id: "mxbai-embed-large:latest", contextWindow: 512, tools: false, sizeBytes: 0.6e9 },
]);

// Credential resolution is mocked so the request-shape tests below can drive
// dispatch() against a stubbed fetch — nothing here touches the network or
// the real secrets store.
vi.mock("./auth/resolve.js", () => ({
  resolveCredential: vi.fn(async () => ({ credential: "sk-ant-api-test-key" })),
}));

// Canonical Anthropic client mocked so the subscription-auth tests can assert
// dispatch routes through it (CLI proxy) instead of a direct fetch.
vi.mock("./anthropic-client/index.js", () => ({
  streamAnthropicResponse: vi.fn(async function* () {
    yield { type: "text", delta: "cli-proxy-reply" };
    yield { type: "done" };
  }),
}));

// Never invokes dispatch(); asserts the helper reads the canonical registry,
// so the per-provider background model can't silently drift away from
// backgroundModelFor().
describe("dispatchBackgroundModel reads the canonical registry", () => {
  it("resolves each dispatch provider via backgroundModelFor (no hardcoded drift)", () => {
    for (const p of ["xai", "openai", "codex", "anthropic"] as const) {
      expect(dispatchBackgroundModel(p)).toBe(backgroundModelFor(p, ""));
    }
  });
});

// The registry's structuredOutput capability flag is the single source of
// truth for whether dispatch forwards responseFormat — no hardcoded provider
// list allowed to drift away from it.
describe("dispatchStructuredOutputEnabled reads the canonical registry", () => {
  it("mirrors capabilities.structuredOutput for every dispatch provider", () => {
    for (const p of ["xai", "openai", "codex", "anthropic"] as const) {
      expect(dispatchStructuredOutputEnabled(p)).toBe(PROVIDERS[p].capabilities.structuredOutput === true);
    }
    // The two openai-compat dispatch paths advertise it today.
    expect(dispatchStructuredOutputEnabled("openai")).toBe(true);
    expect(dispatchStructuredOutputEnabled("xai")).toBe(true);
  });
});

// Regression lock for the additive `images` option: a call WITHOUT images
// must produce the exact request body the pre-images dispatcher sent, and
// non-Anthropic providers must ignore images entirely.
describe("dispatch request shape (fetch stubbed — no network)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localRuntimes = [INSTALLED];
    fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ text: "anthropic-reply" }], choices: [{ message: { content: "openai-reply" } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(): Record<string, unknown> {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>;
  }

  it("anthropic WITHOUT images sends the exact pre-images body (string content, no extra keys)", async () => {
    const out = await dispatch({ prompt: "ping", provider: "anthropic" });
    expect(out).toBe("anthropic-reply");
    expect(sentBody()).toEqual({
      model: dispatchBackgroundModel("anthropic"),
      max_tokens: 200,
      temperature: 0,
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("anthropic WITH images prepends base64 PNG blocks before the text block", async () => {
    await dispatch({ prompt: "judge this", provider: "anthropic", images: ["QUJD"] });
    const body = sentBody();
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          { type: "text", text: "judge this" },
        ],
      },
    ]);
  });

  it("anthropic with an EMPTY images array behaves as if images were absent", async () => {
    await dispatch({ prompt: "ping", provider: "anthropic", images: [] });
    expect(sentBody().messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("openai ignores images silently — same body with or without them", async () => {
    await dispatch({ prompt: "ping", provider: "openai", images: ["QUJD"] });
    expect(sentBody()).toEqual({
      model: dispatchBackgroundModel("openai"),
      temperature: 0,
      max_tokens: 200,
      messages: [{ role: "user", content: "ping" }],
    });
  });

  // A VALID strict schema — strict mode requires `required` covering every
  // property and `additionalProperties: false`, or real OpenAI 400s on it.
  const RESPONSE_FORMAT = {
    type: "json_schema" as const,
    name: "verdict",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    strict: true,
  };

  it("openai passes responseFormat through as the OpenAI response_format wire shape", async () => {
    await dispatch({ prompt: "ping", provider: "openai", responseFormat: RESPONSE_FORMAT });
    expect(sentBody().response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "verdict", schema: RESPONSE_FORMAT.schema, strict: true },
    });
  });

  it("xai passes responseFormat through identically (same openai-compat body)", async () => {
    await dispatch({ prompt: "ping", provider: "xai", responseFormat: RESPONSE_FORMAT });
    const body = sentBody();
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.x.ai/v1/chat/completions");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "verdict", schema: RESPONSE_FORMAT.schema, strict: true },
    });
  });

  it("openai WITHOUT responseFormat sends the exact pre-structured-output body", async () => {
    await dispatch({ prompt: "ping", provider: "openai" });
    expect(sentBody()).toEqual({
      model: dispatchBackgroundModel("openai"),
      temperature: 0,
      max_tokens: 200,
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("anthropic drops responseFormat silently — body unchanged", async () => {
    await dispatch({ prompt: "ping", provider: "anthropic", responseFormat: RESPONSE_FORMAT });
    expect(sentBody()).toEqual({
      model: dispatchBackgroundModel("anthropic"),
      max_tokens: 200,
      temperature: 0,
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("ollama drops responseFormat silently — body unchanged", async () => {
    await dispatch({ prompt: "ping", provider: "ollama", responseFormat: RESPONSE_FORMAT });
    const body = sentBody();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/generate");
    expect("response_format" in body).toBe(false);
  });

  // Regression 2026-07-15: DEFAULTS.ollamaModel pinned "llama3:8b" since April.
  // It was never installed on this box, so every classifier dispatch 404'd
  // /api/generate and surfaced as "empty response". No code changed — the
  // machine's model inventory did. The installed set is the only source of
  // truth for which local model exists.
  describe("ollama model comes from what's INSTALLED, never a hardcoded id", () => {
    it("picks an installed model — and specifically not the old llama3:8b pin", async () => {
      await dispatch({ prompt: "ping", provider: "ollama" });
      expect(sentBody().model).toBe("qwen3.6:27b");
    });

    it("prefers the smallest chat model — these are single-shot classifier prompts", async () => {
      await dispatch({ prompt: "ping", provider: "ollama" });
      expect(sentBody().model).not.toBe("gpt-oss:120b");
    });

    it("never dispatches to an embedding model (it cannot generate)", async () => {
      localRuntimes = [ollamaRuntime([
        { id: "mxbai-embed-large:latest", contextWindow: 512, tools: false, sizeBytes: 0.6e9 },
        { id: "qwen3.6:27b", contextWindow: null, tools: true, sizeBytes: 17e9 },
      ])];
      await dispatch({ prompt: "ping", provider: "ollama" });
      expect(sentBody().model).toBe("qwen3.6:27b");
    });

    it("an explicit caller override still wins", async () => {
      await dispatch({ prompt: "ping", provider: "ollama", ollamaModel: "gpt-oss:120b" });
      expect(sentBody().model).toBe("gpt-oss:120b");
    });

    it("degrades to null WITHOUT a wire call when nothing chat-capable is installed", async () => {
      localRuntimes = [ollamaRuntime([
        { id: "mxbai-embed-large:latest", contextWindow: 512, tools: false, sizeBytes: 0.6e9 },
      ])];
      expect(await dispatch({ prompt: "ping", provider: "ollama" })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("degrades to null WITHOUT a wire call when Ollama isn't running at all", async () => {
      localRuntimes = [];
      expect(await dispatch({ prompt: "ping", provider: "ollama" })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("a 400 with responseFormat sent retries exactly once WITHOUT it, then succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("Invalid schema for response_format 'verdict'", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "healed-reply" } }] }), { status: 200 }));
    const out = await dispatch({ prompt: "ping", provider: "openai", responseFormat: RESPONSE_FORMAT });
    expect(out).toBe("healed-reply");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>;
    const retryBody = JSON.parse(fetchSpy.mock.calls[1][1].body as string) as Record<string, unknown>;
    expect("response_format" in firstBody).toBe(true);
    expect("response_format" in retryBody).toBe(false);
    // Everything else in the retry body is identical to the first send.
    const { response_format: _rf, ...firstRest } = firstBody;
    expect(retryBody).toEqual(firstRest);
  });

  it("a second failure after the responseFormat retry degrades to null as before", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("bad response_format", { status: 400 }))
      .mockResolvedValueOnce(new Response("still broken", { status: 400 }));
    const out = await dispatch({ prompt: "ping", provider: "xai", responseFormat: RESPONSE_FORMAT });
    expect(out).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("a 400 WITHOUT responseFormat sent does not retry — one call, null", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("context length exceeded", { status: 400 }));
    const out = await dispatch({ prompt: "ping", provider: "openai" });
    expect(out).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("anthropic API keys go over direct HTTP with x-api-key, never Bearer", async () => {
    await dispatch({ prompt: "ping", provider: "anthropic" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-api-test-key");
    expect(headers["Authorization"]).toBeUndefined();
    expect(vi.mocked(streamAnthropicResponse)).not.toHaveBeenCalled();
  });
});

// Regression lock for the banned subscription-auth path: Anthropic banned
// direct HTTP for subscription credentials (429 since April 2026). A
// subscription-style token must NEVER be Bearer-fetched to api.anthropic.com —
// it routes through the canonical streamAnthropicResponse (CLI proxy) instead.
describe("anthropic subscription auth never hits direct HTTP", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(streamAnthropicResponse).mockClear();
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ text: "banned-http-reply" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(resolveCredential).mockImplementation(async () => ({ credential: "sk-ant-api-test-key" }) as never);
  });

  it("oauth: token routes via the canonical client, zero direct fetches", async () => {
    vi.mocked(resolveCredential).mockResolvedValueOnce({ credential: "oauth:sub-token" } as never);
    const out = await dispatch({ prompt: "ping", provider: "anthropic" });
    expect(out).toBe("cli-proxy-reply");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(streamAnthropicResponse)).toHaveBeenCalledTimes(1);
    // Credential passes through UNSTRIPPED so the client's own
    // subscription-auth branch (CLI proxy) engages.
    expect(vi.mocked(streamAnthropicResponse).mock.calls[0][0]).toMatchObject({
      token: "oauth:sub-token",
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("sk-ant-oat setup-token also routes via the canonical client (not just oauth: prefix)", async () => {
    vi.mocked(resolveCredential).mockResolvedValueOnce({ credential: "sk-ant-oat01-abc" } as never);
    const out = await dispatch({ prompt: "ping", provider: "anthropic" });
    expect(out).toBe("cli-proxy-reply");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(streamAnthropicResponse)).toHaveBeenCalledTimes(1);
  });

  it("rejectOAuth degrades a subscription credential to null without any network or CLI call", async () => {
    vi.mocked(resolveCredential).mockResolvedValueOnce({ credential: "oauth:sub-token" } as never);
    const out = await dispatch({ prompt: "ping", provider: "anthropic", rejectOAuth: true });
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(streamAnthropicResponse)).not.toHaveBeenCalled();
  });

  it("subscription auth with images degrades to null instead of a doomed direct fetch", async () => {
    vi.mocked(resolveCredential).mockResolvedValueOnce({ credential: "oauth:sub-token" } as never);
    const out = await dispatch({ prompt: "judge", provider: "anthropic", images: ["QUJD"] });
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(streamAnthropicResponse)).not.toHaveBeenCalled();
  });
});
