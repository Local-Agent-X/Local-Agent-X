// The OpenAI-compatible endpoint cannot report a truncated prompt: on Ollama a
// prompt past num_ctx is cut at the FRONT and answered from the tail with
// HTTP 200 (measured 2026-09-19, Ollama 0.34.2). The one tell is that usage
// reports more prompt tokens than the window the runtime has loaded — and
// only a measured window may make that accusation.
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(),
}));

import { promptExceedsMeasuredWindow } from "./request-preflight.js";

describe("promptExceedsMeasuredWindow", () => {
  it("flags a prompt the runtime accepted past a measured window", () => {
    expect(promptExceedsMeasuredWindow(4832, { tokens: 4096, provenance: "probed" })).toBe(true);
    expect(promptExceedsMeasuredWindow(4832, { tokens: 4096, provenance: "exact" })).toBe(true);
  });

  it("never accuses on a guess, never without a count, never at exactly the window", () => {
    expect(promptExceedsMeasuredWindow(20_000, { tokens: 8_192, provenance: "floor" })).toBe(false);
    expect(promptExceedsMeasuredWindow(200_000, { tokens: 128_000, provenance: "heuristic" })).toBe(false);
    expect(promptExceedsMeasuredWindow(undefined, { tokens: 4096, provenance: "probed" })).toBe(false);
    expect(promptExceedsMeasuredWindow(4096, { tokens: 4096, provenance: "probed" })).toBe(false);
  });
});
