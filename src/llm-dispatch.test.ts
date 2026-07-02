import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { dispatch, dispatchBackgroundModel } from "./llm-dispatch.js";
import { backgroundModelFor } from "./providers/registry.js";

// Credential resolution is mocked so the request-shape tests below can drive
// dispatch() against a stubbed fetch — nothing here touches the network or
// the real secrets store.
vi.mock("./auth/resolve.js", () => ({
  resolveCredential: vi.fn(async () => ({ credential: "sk-ant-api-test-key" })),
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

// Regression lock for the additive `images` option: a call WITHOUT images
// must produce the exact request body the pre-images dispatcher sent, and
// non-Anthropic providers must ignore images entirely.
describe("dispatch request shape (fetch stubbed — no network)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
});
