// The one output-cap decision for openai-compat requests. On a MEASURED local
// window the reply gets the real completion budget, and an explicit cap shrinks
// to it — vLLM validates prompt+max_tokens against max_model_len and 400s every
// request otherwise. A guessed local window gets the 16k runaway default; a
// cloud endpoint gets the caller's cap or none. The transports send whatever
// this decides, unchanged.

import { describe, it, expect } from "vitest";
import { applyLocalCap, clampLocalMaxTokens, resolveLocalCap, LOCAL_DEFAULT_MAX_TOKENS, MIN_USEFUL_COMPLETION_TOKENS } from "./local-cap.js";
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
    expect(base()).toBe(131_072 - 3_000 - OUTPUT_RESERVE_TOKENS);
    expect(base({ windowTokens: 8_192 })).toBe(8_192 - 3_000 - OUTPUT_RESERVE_TOKENS);
  });

  it("exact-provenance windows clamp the same as probed ones", () => {
    expect(base({ windowTokens: 8_192, windowProvenance: "exact" })).toBe(8_192 - 3_000 - OUTPUT_RESERVE_TOKENS);
  });

  it("no completion budget left: NO cap at all (never a stub, never the default)", () => {
    const prompt = 8_192 - OUTPUT_RESERVE_TOKENS - MIN_USEFUL_COMPLETION_TOKENS + 1;
    expect(base({ windowTokens: 8_192, promptTokensEstimate: prompt })).toBeUndefined();
  });

  it("a guessed local window gets the runaway default, never a clamp", () => {
    for (const windowProvenance of ["floor", "heuristic"] as const) {
      expect(base({ windowTokens: 8_192, windowProvenance, promptTokensEstimate: 50_000 })).toBe(LOCAL_DEFAULT_MAX_TOKENS);
    }
  });

  it("a guessed local window keeps the caller's explicit cap, unclamped", () => {
    expect(base({ windowProvenance: "floor", explicitMaxTokens: 900, promptTokensEstimate: 50_000 })).toBe(900);
  });

  it("cloud endpoint: explicit cap passes through, nothing is invented", () => {
    expect(base({ isLocalEndpoint: false, explicitMaxTokens: 900, windowTokens: 1 })).toBe(900);
    expect(base({ isLocalEndpoint: false })).toBeUndefined();
    expect(base({ isLocalEndpoint: false, windowProvenance: "heuristic" })).toBeUndefined();
  });

  it("explicit cap is respected when it fits, clamped when it does not, never raised", () => {
    expect(base({ explicitMaxTokens: 512 })).toBe(512); // plenty of room — untouched
    expect(base({ explicitMaxTokens: 16_000, windowTokens: 8_192 })).toBe(
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

  it("puts the decided cap on the request — undefined when there is no room", () => {
    const req: { maxTokens?: number } = {};
    applyLocalCap(req, args);
    expect(req).toEqual({ maxTokens: 131_072 - 3_000 - OUTPUT_RESERVE_TOKENS });
    const full: { maxTokens?: number } = { maxTokens: 512 };
    applyLocalCap(full, { ...args, explicitMaxTokens: 512, window: { tokens: 3_100, provenance: "probed" as const } });
    expect(full).toEqual({ maxTokens: undefined });
  });

  it("an unloaded local model's request carries the 16k default itself", () => {
    const req: { maxTokens?: number } = {};
    applyLocalCap(req, { ...args, window: { tokens: 8_192, provenance: "floor" as const } });
    expect(req.maxTokens).toBe(LOCAL_DEFAULT_MAX_TOKENS);
  });
});

// TB2 adaptive-rejection-sampler, 2026-10-27: qwen3.8 thought 16k, then 32k,
// then 39k tokens before its first tool call, cut off twice by the 16k local
// default and starting over each time.
describe("no flat cap on a measured local window", () => {
  it("a long thought gets the whole budget the window has left, on the first try", () => {
    const cap = base({ windowTokens: 172_032, promptTokensEstimate: 12_000 })!;
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
  const probed = { tokens: 8_192, provenance: "probed" as const };

  it("derives locality from the baseURL", () => {
    const args = { explicitMaxTokens: undefined, window: probed, fit: fit() };
    expect(resolveLocalCap({ baseURL: "http://127.0.0.1:11434/v1", ...args })).toBe(8_192 - 3_000 - OUTPUT_RESERVE_TOKENS);
    expect(resolveLocalCap({ ...args, baseURL: "http://192.168.1.50:8000/v1", window: { tokens: 8_192, provenance: "floor" } }))
      .toBe(LOCAL_DEFAULT_MAX_TOKENS);
    expect(resolveLocalCap({ baseURL: "https://api.llm-cloud.example/v1", ...args })).toBeUndefined();
    expect(resolveLocalCap({ baseURL: undefined, ...args })).toBeUndefined();
  });

  it("sizes against the FULL requestTokens — the manifest ships, so it eats the budget", () => {
    // The preflight never strips tools, so the estimate must not subtract
    // toolTokens: 8_192 − 7_500 − reserve is under the useful minimum → no cap.
    const local = "http://127.0.0.1:11434/v1";
    const tight = fit({ requestTokens: 7_500, toolTokens: 5_000 });
    expect(resolveLocalCap({ baseURL: local, explicitMaxTokens: undefined, window: probed, fit: tight })).toBeUndefined();
    // And with a smaller request the budget is window − requestTokens − reserve.
    const roomy = fit({ requestTokens: 4_000, toolTokens: 2_000 });
    expect(resolveLocalCap({ baseURL: local, explicitMaxTokens: undefined, window: probed, fit: roomy }))
      .toBe(8_192 - 4_000 - OUTPUT_RESERVE_TOKENS);
  });
});
