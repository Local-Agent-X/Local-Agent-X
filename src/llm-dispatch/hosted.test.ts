import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Credential resolution mocked so callAnthropic's raw API-key leg can be
// driven against a stubbed fetch — no network, no secrets store.
const mocks = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  streamAnthropicResponse: vi.fn(),
}));
vi.mock("../auth/resolve.js", () => ({ resolveCredential: mocks.resolveCredential }));
vi.mock("../anthropic-client/index.js", () => ({ streamAnthropicResponse: mocks.streamAnthropicResponse }));

import { callAnthropic, imageMediaType } from "./hosted.js";

// Regression lock: the raw API-key leg used to put the caller's model id on
// the wire UNNORMALIZED. The Messages API only accepts runtime ids, so every
// alias users actually have in settings — "anthropic/…" prefixes, dotted
// versions, "[1m]" suffixes, dated snapshots — 404'd on this leg while the
// canonical client (stream-api.ts) resolved them fine. The fix runs
// normalizeAnthropicModel (the one alias map) at the seam; these pins keep the
// wire model normalized and the adaptive-thinking temperature gate keyed off
// the normalized id.
describe("callAnthropic raw leg normalizes the model id (fetch stubbed — no network)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.resolveCredential.mockResolvedValue({ credential: "sk-ant-api-test" });
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ text: "reply" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function sentBody(): Record<string, unknown> {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>;
  }

  const ALIASES: Array<[string, string]> = [
    ["anthropic/claude-fable-5", "claude-fable-5"],
    ["claude-fable.5", "claude-fable-5"],
    ["claude-opus-5[1m]", "claude-opus-5"],
    ["claude-sonnet-4.6", "claude-sonnet-4-6"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
  ];
  it.each(ALIASES)("alias %s goes on the wire as runtime id %s", async (alias, runtime) => {
    const out = await callAnthropic("anthropic-api", "ping", alias, 0, 200, 1000, false);
    expect(out).toBe("reply");
    expect(sentBody().model).toBe(runtime);
  });

  it("resolves the credential of the picker entry it was called for, never the other one", async () => {
    await callAnthropic("anthropic-api", "ping", "claude-haiku-4-5", 0, 200, 1000, false);
    expect(mocks.resolveCredential).toHaveBeenCalledWith("anthropic-api", { rejectOAuth: false });
    await callAnthropic("anthropic", "ping", "claude-haiku-4-5", 0, 200, 1000, false);
    expect(mocks.resolveCredential).toHaveBeenLastCalledWith("anthropic", { rejectOAuth: false });
  });

  it("runtime ids pass through byte-identical (legacy model keeps temperature on the wire)", async () => {
    await callAnthropic("anthropic-api", "ping", "claude-haiku-4-5", 0, 200, 1000, false);
    expect(sentBody()).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      temperature: 0,
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("unknown ids are left alone — normalization never invents a model", async () => {
    await callAnthropic("anthropic-api", "ping", "claude-experimental-9", 0, 200, 1000, false);
    expect(sentBody().model).toBe("claude-experimental-9");
  });

  it("adaptive gate keys off the NORMALIZED id: an alias of an adaptive model sends NO temperature", async () => {
    await callAnthropic("anthropic-api", "ping", "anthropic/claude-fable-5[1m]", 0, 200, 1000, false);
    const body = sentBody();
    expect(body.model).toBe("claude-fable-5");
    expect("temperature" in body).toBe(false);
  });

  it("legacy alias keeps temperature: dated Haiku snapshot normalizes AND still sends temperature 0", async () => {
    await callAnthropic("anthropic-api", "ping", "claude-haiku-4-5-20251001", 0, 200, 1000, false);
    const body = sentBody();
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.temperature).toBe(0);
  });
});

// The subscription leg rides streamAnthropicResponse; without an explicit
// maxTokens the client falls back to the model's full output budget (64k on
// Haiku), so a dispatch caller's tight cap (200 for classifiers/rerank) was
// silently dropped on that leg. Pin: the cap reaches the client verbatim.
describe("callAnthropic subscription leg forwards maxTokens (client stubbed — no network)", () => {
  beforeEach(() => {
    mocks.resolveCredential.mockResolvedValue({ credential: "oauth:sub-token" });
    mocks.streamAnthropicResponse.mockImplementation(async function* () {
      yield { type: "text", delta: "sub-reply" };
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("raw fetch must not run for subscription creds"); }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("passes the caller's cap through to streamAnthropicResponse, token unstripped", async () => {
    const out = await callAnthropic("anthropic", "ping", "claude-haiku-4-5", 0, 200, 1000, false);
    expect(out).toBe("sub-reply");
    expect(mocks.streamAnthropicResponse).toHaveBeenCalledTimes(1);
    const opts = mocks.streamAnthropicResponse.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.maxTokens).toBe(200);
    expect(opts.token).toBe("oauth:sub-token");
  });
});

// A call's camera frame is JPEG; every image used to be declared image/png, and the
// Anthropic API refuses an image whose declared type is not what its bytes are.
describe("dispatch images carry the type their bytes are", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

  it("reads JPEG, PNG and WebP from the bytes, PNG when unknown", () => {
    expect(imageMediaType(jpeg)).toBe("image/jpeg");
    expect(imageMediaType(png)).toBe("image/png");
    expect(imageMediaType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).toString("base64"))).toBe("image/webp");
    expect(imageMediaType(Buffer.from("hello there").toString("base64"))).toBe("image/png");
  });

  it("a JPEG on the subscription leg goes as a JPEG data URL", async () => {
    mocks.resolveCredential.mockResolvedValue({ credential: "oauth:sub-token" });
    mocks.streamAnthropicResponse.mockImplementation(async function* () { yield { type: "text", delta: "NO" }; });
    await callAnthropic("anthropic", "look", "claude-opus-5-5", 0, 120, 1000, false, [jpeg]);
    const opts = mocks.streamAnthropicResponse.mock.calls[0][0] as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> };
    expect(opts.messages[0]!.content[0]!.image_url!.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    vi.clearAllMocks();
  });
});
