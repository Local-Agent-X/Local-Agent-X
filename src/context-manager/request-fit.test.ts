// Request-fit preflight — the sizing math that keeps a request whose FIXED
// overhead (system prompt + tool manifest) can't fit from ever reaching the
// engine. Regression anchor: 2026-07-15, a 36,611-token "hi" request sent to
// an LM Studio gemma loaded with n_ctx 8,192 → raw exceed_context_size_error.
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import {
  assessRequestFit,
  describeUnfittableRequest,
  toolManifestTokens,
  OUTPUT_RESERVE_TOKENS,
} from "./request-fit.js";

const hi: ChatCompletionMessageParam[] = [{ role: "user", content: "hi" }];

/** A tool whose serialized schema estimates to roughly `tokens` tokens. */
function toolOfRoughly(tokens: number, name = "big_tool") {
  return { name, description: "x".repeat(Math.max(0, tokens * 3.5 - 100)), parameters: {} };
}

describe("assessRequestFit", () => {
  it("fits: small prompt + small tools inside a large window", () => {
    const fit = assessRequestFit({
      windowTokens: 128_000,
      systemPrompt: "You are a helpful assistant.",
      tools: [{ name: "read_file", description: "read a file", parameters: { type: "object" } }],
      messages: hi,
    });
    expect(fit.verdict).toBe("fits");
    expect(fit.requestTokens).toBe(fit.systemTokens + fit.toolTokens + fit.messageTokens);
  });

  it("too_big: a tool manifest that doesn't fit is too_big — tools are fixed overhead, never stripped", () => {
    // 2026-09-08 muse-glimmer:30b: dropping the manifest mid-turn made the
    // model hallucinate tool calls as prose. System + messages alone would
    // fit here; the verdict must still refuse rather than offer a tools-off send.
    const fit = assessRequestFit({
      windowTokens: 8_192,
      systemPrompt: "short system prompt",
      tools: [toolOfRoughly(30_000)], // manifest >> window; system + messages tiny
      messages: hi,
    });
    expect(fit.verdict).toBe("too_big");
    expect(fit.systemTokens + fit.messageTokens).toBeLessThan(8_192 - OUTPUT_RESERVE_TOKENS);
    expect(fit.requestTokens).toBe(fit.systemTokens + fit.toolTokens + fit.messageTokens);
  });

  it("no verdict ever strips tools: every outcome is fits or too_big, sized with the manifest in", () => {
    const shapes = [
      { windowTokens: 128_000, systemPrompt: "s", tools: [toolOfRoughly(100)] },
      { windowTokens: 8_192, systemPrompt: "s", tools: [toolOfRoughly(30_000)] },
      { windowTokens: 8_192, systemPrompt: "s".repeat(12_000 * 4), tools: [toolOfRoughly(24_000)] },
      { windowTokens: 8_192, systemPrompt: "s".repeat(12_000 * 4), tools: [] },
    ];
    for (const shape of shapes) {
      const fit = assessRequestFit({ ...shape, messages: hi });
      expect(["fits", "too_big"]).toContain(fit.verdict);
      expect(fit.requestTokens).toBe(fit.systemTokens + fit.toolTokens + fit.messageTokens);
    }
  });

  it("too_big: system prompt alone exceeds the window (gemma-4-e4b regression shape)", () => {
    const fit = assessRequestFit({
      windowTokens: 8_192,
      systemPrompt: "s".repeat(12_000 * 4), // ~12k tokens of system prompt into an 8k window
      tools: [toolOfRoughly(24_000)],
      messages: hi,
    });
    expect(fit.verdict).toBe("too_big");
  });

  it("reserves output headroom — a prompt that exactly fills the window does NOT fit", () => {
    const windowTokens = 8_192;
    // Compose a request estimating to just over window − reserve.
    const fit = assessRequestFit({
      windowTokens,
      systemPrompt: "s".repeat((windowTokens - OUTPUT_RESERVE_TOKENS) * 4),
      tools: [],
      messages: hi,
    });
    expect(fit.verdict).toBe("too_big");
  });

  it("counts every tool in the manifest, not just the first", () => {
    const one = toolManifestTokens([toolOfRoughly(1_000, "a")]);
    const five = toolManifestTokens([
      toolOfRoughly(1_000, "a"),
      toolOfRoughly(1_000, "b"),
      toolOfRoughly(1_000, "c"),
      toolOfRoughly(1_000, "d"),
      toolOfRoughly(1_000, "e"),
    ]);
    expect(five).toBeGreaterThan(one * 4);
  });
});

describe("describeUnfittableRequest", () => {
  it("names the model, the window, every component's size, and the fixes", () => {
    const fit = assessRequestFit({
      windowTokens: 8_192,
      systemPrompt: "s".repeat(36_000 * 3.5),
      tools: [toolOfRoughly(2_000)],
      messages: hi,
    });
    const msg = describeUnfittableRequest("google/gemma-4-e4b", fit);
    expect(msg).toContain("google/gemma-4-e4b");
    expect(msg).toContain("8,192");
    expect(msg).toContain(fit.systemTokens.toLocaleString("en-US"));
    expect(msg).toContain(fit.toolTokens.toLocaleString("en-US"));
    expect(msg).toContain(fit.messageTokens.toLocaleString("en-US"));
    expect(msg).toMatch(/context length|context slider|num_ctx/);
    expect(msg).toMatch(/larger-window model/);
    expect(msg).toMatch(/shrink the tool set/);
    expect(msg).not.toMatch(/tools dropped|without tools/);
  });
});
