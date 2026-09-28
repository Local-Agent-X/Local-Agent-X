/**
 * The reasoning-param decision, and specifically: with thinking-off unused,
 * this must behave EXACTLY as the inline gate it replaced.
 *
 * EXP-6 and EXP-6b both reverted, leaving this code shipped but unused. That
 * is only safe if "unused" is actually true, and "I read the code and it looks
 * equivalent" is the reasoning that already cost two wrong claims in this
 * campaign. So the equivalence is pinned here.
 */
import { describe, it, expect, vi } from "vitest";

// Profiles decide replay; pin one opted-in id so the mechanism is tested
// independently of what the shipped profiles currently declare.
vi.mock("../../local-runtimes/model-profile.js", () => ({
  modelReplaysReasoning: (model: string) => model === "replayer:8b",
}));

import { resolveReasoningParam, isReasoningCapable } from "./openai-param-support.js";

const OLLAMA = "http://127.0.0.1:11434/v1";
const CLOUD = "https://api.openai.com/v1";

describe("with thinking-off unused, nothing changed", () => {
  it("an unprofiled local model is sent NO reasoning_effort, exactly as before", () => {
    // The name-based capability check does not match qwen3:8b; since EXP-36
    // its profile (replayReasoning) sends the param anyway, so the "nothing
    // on the wire" path is pinned on a local model with no profile.
    expect(isReasoningCapable(OLLAMA, "qwen3:8b")).toBe(false);
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "llama3:8b", effort: "medium" }).send).toBe(false);
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "llama3:8b", effort: undefined }).send).toBe(false);
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

describe("resolveReasoningParam — a profile that replays its reasoning", () => {
  // Ollama /v1 sets its think switch from reasoning_effort, and the Qwen
  // templates render a prior <think> only when it is set; a replaying
  // profile therefore gets the param on a loopback endpoint even though its
  // name is not in the reasoning-capable list — and only on a loopback one.
  it("sends reasoning_effort locally for a replaying profile, not for any other local model or in the cloud", () => {
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "replayer:8b", effort: undefined }).send).toBe(true);
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "qwen3:8b", effort: undefined }).send).toBe(false);
    expect(resolveReasoningParam({ baseURL: CLOUD, model: "replayer:8b", effort: undefined }).send).toBe(false);
  });
});
