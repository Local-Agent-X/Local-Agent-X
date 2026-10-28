// Window-aware output cap: on a MEASURED local window the reply gets the real
// completion budget, and an explicit cap shrinks to it — vLLM validates
// prompt+max_tokens against max_model_len and 400s every request otherwise —
// while guesses (floor/heuristic windows) and cloud endpoints change nothing.

import { describe, it, expect } from "vitest";
import { applyLocalCap, clampLocalMaxTokens, resolveLocalCap, MIN_USEFUL_COMPLETION_TOKENS } from "./local-cap.js";
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
  it("measured window: the cap is the whole budget, window − prompt − reserve", () => {
    expect(base()).toEqual({ maxTokens: 131_072 - 3_000 - OUTPUT_RESERVE_TOKENS, omitDefault: false });
    expect(base({ windowTokens: 8_192 })).toEqual({ maxTokens: 8_192 - 3_000 - OUTPUT_RESERVE_TOKENS, omitDefault: false });
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

describe("applyLocalCap", () => {
  const args = {
    baseURL: "http://127.0.0.1:11434/v1", explicitMaxTokens: undefined,
    window: { tokens: 131_072, provenance: "probed" as const },
    fit: { requestTokens: 3_000 } as RequestFit,
  };

  it("puts the decided cap on the request, and the omit flag only when there is no room", () => {
    const req: { maxTokens?: number; omitDefaultMaxTokens?: boolean } = {};
    applyLocalCap(req, args);
    expect(req).toEqual({ maxTokens: 131_072 - 3_000 - OUTPUT_RESERVE_TOKENS });
    const full: { maxTokens?: number; omitDefaultMaxTokens?: boolean } = {};
    applyLocalCap(full, { ...args, window: { tokens: 3_100, provenance: "probed" as const } });
    expect(full).toEqual({ maxTokens: undefined, omitDefaultMaxTokens: true });
  });
});

// TB2 adaptive-rejection-sampler, 2026-10-27: qwen3.8 thought 16k, then 32k,
// then 39k tokens before its first tool call, cut off twice by the 16k local
// default and starting over each time.
describe("no flat cap on a measured local window", () => {
  it("a long thought gets the whole budget the window has left, on the first try", () => {
    const cap = base({ windowTokens: 172_032, promptTokensEstimate: 12_000 }).maxTokens!;
    expect(cap).toBe(172_032 - 12_000 - OUTPUT_RESERVE_TOKENS);
    expect(cap).toBeGreaterThan(40_000);
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
    outputReserveTokens: OUTPUT_RESERVE_TOKENS,
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

  it("sizes against the FULL requestTokens — the manifest ships, so it eats the budget", () => {
    // The preflight never strips tools, so the estimate must not subtract
    // toolTokens: 8_192 − 7_500 − reserve is under the useful minimum → omit.
    const fullFit = fit({ requestTokens: 7_500, toolTokens: 5_000 });
    const d = resolveLocalCap({
      baseURL: "http://127.0.0.1:11434/v1",
      explicitMaxTokens: undefined,
      window: { tokens: 8_192, provenance: "probed" },
      fit: fullFit,
    });
    expect(d).toEqual({ maxTokens: undefined, omitDefault: true });
    // And with a smaller request the budget is window − requestTokens − reserve.
    const roomy = resolveLocalCap({
      baseURL: "http://127.0.0.1:11434/v1",
      explicitMaxTokens: undefined,
      window: { tokens: 8_192, provenance: "probed" },
      fit: fit({ requestTokens: 4_000, toolTokens: 2_000 }),
    });
    expect(roomy).toEqual({ maxTokens: 8_192 - 4_000 - OUTPUT_RESERVE_TOKENS, omitDefault: false });
  });
});
