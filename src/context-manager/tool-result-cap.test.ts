import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_TOOL_MANIFEST_TOKENS,
  MIN_RESULT_CAP_CHARS,
  toolResultCapChars,
} from "./tool-result-cap.js";
import { OUTPUT_RESERVE_TOKENS, PROMPT_WINDOW_SHARE } from "./request-fit.js";
import { LOCAL_UNKNOWN_CONTEXT } from "./model-windows.js";

// The per-result cap is a function of the window. Regression for 2026-09-08:
// a 65,536-token local model got the flat 50k-char (~14k-token) cap, and two
// such results overflowed the window inside one step.

describe("toolResultCapChars — window-derived per-result cap", () => {
  it("65,536: reserves prompt share + manifest + response reserve, then 1/4 of the rest", () => {
    // Arithmetic from the module header, recomputed here so a drift in any
    // constant fails loudly instead of silently moving the cap.
    const prompt = Math.floor(65_536 * PROMPT_WINDOW_SHARE); // 22,937
    const messages = 65_536 - prompt - DEFAULT_TOOL_MANIFEST_TOKENS - OUTPUT_RESERVE_TOKENS; // 27,575
    const expected = Math.floor(Math.floor(messages / 4) * 3.5); // 24,125
    const cap = toolResultCapChars(65_536);
    expect(cap).toBe(expected);
    expect(cap).toBe(24_125);
    expect(cap).toBeLessThan(DEFAULT_MAX_RESULT_CHARS);
    // Four max-size results (one parallel batch) fit the message budget.
    expect(Math.ceil((cap * 4) / 3.5)).toBeLessThanOrEqual(messages);
  });

  it("200,000 (cloud): clamps to the historical default — cloud models are unchanged", () => {
    expect(toolResultCapChars(200_000)).toBe(DEFAULT_MAX_RESULT_CHARS);
    expect(toolResultCapChars(1_000_000)).toBe(DEFAULT_MAX_RESULT_CHARS);
  });

  it("131,072: the largest common local window still gets the full default", () => {
    expect(toolResultCapChars(131_072)).toBe(DEFAULT_MAX_RESULT_CHARS);
  });

  it("8,192 (the local floor value) sits at the hard floor, never below it", () => {
    // Overhead alone exceeds this window; the floor keeps results usable.
    // (Whether an 8,192 is a MEASUREMENT or the placeholder is the caller's
    // provenance decision — see audit-tool-call's applyBudget.)
    expect(toolResultCapChars(LOCAL_UNKNOWN_CONTEXT)).toBe(MIN_RESULT_CAP_CHARS);
  });

  it("is monotonic in the window", () => {
    const caps = [16_384, 32_768, 49_152, 65_536, 98_304, 131_072].map(w => toolResultCapChars(w));
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
  });

  it("a measured manifest replaces the documented allowance", () => {
    // Lighter manifest -> more room per result; heavier -> less.
    expect(toolResultCapChars(65_536, 4_000)).toBeGreaterThan(toolResultCapChars(65_536));
    expect(toolResultCapChars(65_536, 30_000)).toBeLessThan(toolResultCapChars(65_536));
  });

  it("nonsense windows fall back to the default", () => {
    expect(toolResultCapChars(0)).toBe(DEFAULT_MAX_RESULT_CHARS);
    expect(toolResultCapChars(Number.NaN)).toBe(DEFAULT_MAX_RESULT_CHARS);
  });
});
