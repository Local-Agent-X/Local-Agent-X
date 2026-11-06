/**
 * Pins the reasoning.effort seam in buildRequestBody: the user-selected
 * thinking depth (settings.reasoningEffort → Think picker) must reach the
 * Responses API body verbatim, and the absence of a selection must keep the
 * long-standing "medium" default (high timed out, low emptied ~40% of turns).
 */
import { describe, expect, it } from "vitest";
import { buildHeaders, buildRequestBody, promptCacheKey } from "./request.js";

const BASE = {
  model: "gpt-5.6-sol",
  systemPrompt: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("buildRequestBody — reasoning.effort", () => {
  it("defaults to medium when no effort is selected", () => {
    const body = buildRequestBody(BASE);
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it("sends supported GPT-5.6 efforts verbatim, including xhigh (Max)", () => {
    for (const effort of ["low", "high", "xhigh"] as const) {
      const body = buildRequestBody({ ...BASE, reasoningEffort: effort });
      expect(body.reasoning).toEqual({ effort, summary: "auto" });
    }
  });

  it("maps the legacy minimal level to low for GPT-5.6", () => {
    const body = buildRequestBody({ ...BASE, reasoningEffort: "minimal" });
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("preserves minimal for Codex models that still accept it", () => {
    const body = buildRequestBody({ ...BASE, model: "gpt-5.5", reasoningEffort: "minimal" });
    expect(body.reasoning).toEqual({ effort: "minimal", summary: "auto" });
  });
});

describe("the conversation's cache key", () => {
  // Without one the ChatGPT backend served no request from cache (an identical
  // request sent twice read 0 cached tokens, 2026-11-06).
  it("rides as session_id and prompt_cache_key, the same per session and never the raw id", () => {
    const body = buildRequestBody({ model: "gpt-5.6-sol", systemPrompt: "s", messages: [], sessionId: "sess_abc" });
    const headers = buildHeaders("t", "sess_abc");
    expect(body.prompt_cache_key).toBe(promptCacheKey("sess_abc"));
    expect(headers.session_id).toBe(promptCacheKey("sess_abc"));
    expect(promptCacheKey("sess_abc")).not.toContain("sess_abc");
    expect(promptCacheKey("sess_abc")).not.toBe(promptCacheKey("sess_xyz"));
  });

  it("is absent without a session", () => {
    expect(buildRequestBody({ model: "gpt-5.6-sol", systemPrompt: "s", messages: [] }).prompt_cache_key).toBeUndefined();
    expect(buildHeaders("t").session_id).toBeUndefined();
  });
});
