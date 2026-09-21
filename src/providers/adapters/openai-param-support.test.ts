/**
 * The reasoning-param decision, and specifically: with thinking-off unused,
 * this must behave EXACTLY as the inline gate it replaced.
 *
 * EXP-6 and EXP-6b both reverted, leaving this code shipped but unused. That
 * is only safe if "unused" is actually true, and "I read the code and it looks
 * equivalent" is the reasoning that already cost two wrong claims in this
 * campaign. So the equivalence is pinned here.
 */
import { describe, it, expect } from "vitest";
import { resolveReasoningParam, isReasoningCapable } from "./openai-param-support.js";

const OLLAMA = "http://127.0.0.1:11434/v1";
const CLOUD = "https://api.openai.com/v1";

describe("with thinking-off unused, nothing changed", () => {
  it("a local non-reasoning model is sent NO reasoning_effort, exactly as before", () => {
    // qwen3:8b does not match the OSS reasoning-model fallback, so the param
    // was never sent for it and still is not. This is the path every local
    // turn takes today.
    expect(isReasoningCapable(OLLAMA, "qwen3:8b")).toBe(false);
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "qwen3:8b", effort: "medium" }).send).toBe(false);
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "qwen3:8b", effort: undefined }).send).toBe(false);
  });

  it("a reasoning-capable model still gets its session depth verbatim", () => {
    expect(isReasoningCapable(OLLAMA, "deepseek-r1:7b")).toBe(true);
    const d = resolveReasoningParam({ baseURL: OLLAMA, model: "deepseek-r1:7b", effort: "high" });
    expect(d).toEqual({ send: true, value: "high" });
  });

  it("absent effort falls back to the same default the inline gate used", () => {
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "gpt-oss:20b", effort: undefined }).value).toBe("medium");
  });

  it("xhigh still clamps to high on Chat Completions", () => {
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "gpt-oss:20b", effort: "xhigh" }).value).toBe("high");
  });
});

describe("thinking-off, if a profile ever asks for it again", () => {
  it("is sent only to a local endpoint, which is the only place it was measured", () => {
    const local = resolveReasoningParam({ baseURL: OLLAMA, model: "qwen3:8b", effort: "none" });
    expect(local).toEqual({ send: true, value: "none" });
  });

  it("never reaches a cloud endpoint — it clamps to the nearest real depth", () => {
    const cloud = resolveReasoningParam({ baseURL: CLOUD, model: "gpt-4o", effort: "none" });
    expect(cloud.value).toBe("minimal");
    expect(cloud.value).not.toBe("none");
  });

  it("is not sent at all when the endpoint has already rejected the param", async () => {
    const { markParamUnsupported } = await import("../types.js");
    markParamUnsupported(OLLAMA, "sulky:1b", "reasoning_effort");
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "sulky:1b", effort: "none" }).send).toBe(false);
  });
});
