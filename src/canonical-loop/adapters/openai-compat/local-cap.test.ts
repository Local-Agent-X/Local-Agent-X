// Window-aware output-cap clamp: on a MEASURED local window the default (or
// explicit) cap must shrink to the real completion budget — vLLM validates
// prompt+max_tokens against max_model_len and 400s every request otherwise —
// while guesses (floor/heuristic windows) and cloud endpoints change nothing.

import { describe, it, expect } from "vitest";
import { clampLocalMaxTokens, resolveLocalCap, MIN_USEFUL_COMPLETION_TOKENS } from "./local-cap.js";
import { LOCAL_DEFAULT_MAX_TOKENS } from "../../../providers/adapter/types.js";
import { OUTPUT_RESERVE_TOKENS, type RequestFit } from "../../../context-manager/request-fit.js";

function base(over: Partial<Parameters<typeof clampLocalMaxTokens>[0]> = {}) {
  return clampLocalMaxTokens({
    isLocalEndpoint: true,
    explicitMaxTokens: undefined,
    windowTokens: 131_072,
    windowProvenance: "probed",
    promptTokensEstimate: 3_000,
    ...over,
  });
}

describe("clampLocalMaxTokens", () => {
  it("big measured window: default rides through unclamped", () => {
    expect(base()).toEqual({ maxTokens: LOCAL_DEFAULT_MAX_TOKENS, omitDefault: false });
  });

  it("small measured window: default clamps to window − prompt − reserve", () => {
    const d = base({ windowTokens: 8_192 });
    expect(d).toEqual({ maxTokens: 8_192 - 3_000 - OUTPUT_RESERVE_TOKENS, omitDefault: false });
    expect(d.maxTokens!).toBeLessThan(LOCAL_DEFAULT_MAX_TOKENS);
  });

  it("exact-provenance windows clamp the same as probed ones", () => {
    expect(base({ windowTokens: 8_192, windowProvenance: "exact" }).maxTokens).toBe(
      8_192 - 3_000 - OUTPUT_RESERVE_TOKENS,
    );
  });

  it("no completion budget left: OMIT the cap entirely (never send a stub)", () => {
    const d = base({ windowTokens: 8_192, promptTokensEstimate: 8_192 - OUTPUT_RESERVE_TOKENS - MIN_USEFUL_COMPLETION_TOKENS + 1 });
    expect(d).toEqual({ maxTokens: undefined, omitDefault: true });
  });

  it("floor window (unloaded model) is a guess — never clamped, never omitted", () => {
    expect(base({ windowTokens: 8_192, windowProvenance: "floor", promptTokensEstimate: 50_000 })).toEqual({
      maxTokens: undefined,
      omitDefault: false,
    });
  });

  it("heuristic window is a guess too — passthrough", () => {
    expect(base({ windowProvenance: "heuristic", windowTokens: 4_096, promptTokensEstimate: 50_000 })).toEqual({
      maxTokens: undefined,
      omitDefault: false,
    });
  });

  it("cloud endpoint: explicit cap passes through, nothing is invented", () => {
    expect(base({ isLocalEndpoint: false, explicitMaxTokens: 900, windowTokens: 1 })).toEqual({
      maxTokens: 900,
      omitDefault: false,
    });
    expect(base({ isLocalEndpoint: false })).toEqual({ maxTokens: undefined, omitDefault: false });
  });

  it("explicit cap is respected when it fits, clamped when it does not, never raised", () => {
    expect(base({ explicitMaxTokens: 512 }).maxTokens).toBe(512); // plenty of room — untouched
    expect(base({ explicitMaxTokens: 16_000, windowTokens: 8_192 }).maxTokens).toBe(
      8_192 - 3_000 - OUTPUT_RESERVE_TOKENS, // 4168 < 16000 — clamped
    );
  });
});

describe("resolveLocalCap (seam wrapper)", () => {
  const fit = (over: Partial<RequestFit> = {}): RequestFit => ({
    verdict: "fits",
    windowTokens: 8_192,
    requestTokens: 3_000,
    systemTokens: 2_000,
    toolTokens: 900,
    messageTokens: 100,
    ...over,
  });

  it("derives locality from the baseURL", () => {
    const args = { explicitMaxTokens: undefined, window: { tokens: 8_192, provenance: "probed" as const }, fit: fit() };
    expect(resolveLocalCap({ baseURL: "http://127.0.0.1:11434/v1", ...args }).maxTokens).toBe(
      8_192 - 3_000 - OUTPUT_RESERVE_TOKENS,
    );
    expect(resolveLocalCap({ baseURL: "https://api.llm-cloud.example/v1", ...args })).toEqual({
      maxTokens: undefined,
      omitDefault: false,
    });
  });

  it("a tools-stripped turn (fits_without_tools) sizes against the request WITHOUT the manifest", () => {
    // With the manifest counted the budget would be gone; without it there is
    // room — the wrapper must use the stripped size.
    const strippedFit = fit({
      verdict: "fits_without_tools",
      requestTokens: 7_500,
      toolTokens: 5_000,
    });
    const d = resolveLocalCap({
      baseURL: "http://127.0.0.1:11434/v1",
      explicitMaxTokens: undefined,
      window: { tokens: 8_192, provenance: "probed" },
      fit: strippedFit,
    });
    expect(d).toEqual({ maxTokens: 8_192 - 2_500 - OUTPUT_RESERVE_TOKENS, omitDefault: false });
  });
});
