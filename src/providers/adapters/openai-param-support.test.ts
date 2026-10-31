/**
 * The reasoning-param decision for the Chat Completions transport.
 *
 * A local endpoint is sent the user's depth for every model and learns from a
 * 400 what a model rejects; a cloud endpoint is sent it only for a model its
 * provider row (or, with no row, the OSS-family catalog) says reasons. Until
 * 2026-10-31 the local side was gated by that same name list, and the Think
 * picker did nothing for a local model the list did not know.
 */
import { describe, it, expect } from "vitest";

import { resolveReasoningParam, isReasoningCapable } from "./openai-param-support.js";

const OLLAMA = "http://127.0.0.1:11434/v1";
const LMSTUDIO = "http://192.168.1.50:1234/v1";
const CLOUD = "https://api.openai.com/v1";
const UNKNOWN_CLOUD = "https://llm.example.com/v1";

describe("a local endpoint is asked, never matched by name", () => {
  it("sends the session depth for any local model, known name or not", () => {
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "qwen3.8:27b", effort: "high" })).toEqual({ send: true, value: "high" });
    expect(resolveReasoningParam({ baseURL: LMSTUDIO, model: "llama3:8b", effort: "low" })).toEqual({ send: true, value: "low" });
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "llama3:8b", effort: undefined }).value).toBe("medium");
  });

  it("stops sending once the endpoint has rejected the param for that model", async () => {
    const { markParamUnsupported } = await import("../types.js");
    markParamUnsupported(OLLAMA, "sulky:1b", "reasoning_effort");
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "sulky:1b", effort: "medium" }).send).toBe(false);
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "sulky:1b", effort: "none" }).send).toBe(false);
  });

  it("xhigh still clamps to high on Chat Completions", () => {
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "gpt-oss:20b", effort: "xhigh" }).value).toBe("high");
  });
});

describe("a cloud endpoint goes by its catalog", () => {
  it("a cloud model its provider row does not list reasoning for is sent nothing", () => {
    expect(isReasoningCapable(CLOUD, "gpt-4o")).toBe(false);
    expect(resolveReasoningParam({ baseURL: CLOUD, model: "gpt-4o", effort: "high" }).send).toBe(false);
  });

  it("a cloud URL no provider row owns falls back to the OSS reasoning families", () => {
    expect(isReasoningCapable(UNKNOWN_CLOUD, "deepseek-r1:7b")).toBe(true);
    expect(isReasoningCapable(UNKNOWN_CLOUD, "qwen3:8b")).toBe(false);
    expect(resolveReasoningParam({ baseURL: UNKNOWN_CLOUD, model: "deepseek-r1:7b", effort: "high" })).toEqual({ send: true, value: "high" });
    expect(resolveReasoningParam({ baseURL: UNKNOWN_CLOUD, model: "qwen3:8b", effort: "high" }).send).toBe(false);
  });
});

describe("thinking-off", () => {
  it("is sent only to a local endpoint, which is the only place it was measured", () => {
    expect(resolveReasoningParam({ baseURL: OLLAMA, model: "qwen3:8b", effort: "none" })).toEqual({ send: true, value: "none" });
  });

  it("never reaches a cloud endpoint — it clamps to the nearest real depth", () => {
    const cloud = resolveReasoningParam({ baseURL: CLOUD, model: "o3-mini", effort: "none" });
    expect(cloud.value).toBe("minimal");
    expect(cloud.value).not.toBe("none");
  });
});
