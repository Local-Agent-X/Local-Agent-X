// Unit twin of request-preflight.ts: the decision is a pure function of
// (window, composed request). Provenance — not the integer — decides whether
// a too_big verdict may refuse, and the request is never mutated either way.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(),
}));

import { assessOpenAiCompatPreflight } from "./request-preflight.js";
import { resolveContextWindow } from "../../../context-manager/model-windows.js";

const mockWindow = vi.mocked(resolveContextWindow);

function bigTool(tokens: number, name = "mega_tool") {
  return { name, description: "x".repeat(tokens * 3.5), parameters: { type: "object" } };
}

function req(tools: ReturnType<typeof bigTool>[] = []) {
  return {
    systemPrompt: "You are Agent X.",
    tools,
    messages: [{ role: "user" as const, content: "hi" }],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("assessOpenAiCompatPreflight", () => {
  it("fits on a measured window → send, fit carries the full sizing", () => {
    mockWindow.mockReturnValue({ tokens: 128_000, provenance: "probed" });
    const r = req([bigTool(500)]);
    const d = assessOpenAiCompatPreflight({ model: "m", req: r });
    expect(d.kind).toBe("send");
    expect(d.window).toEqual({ tokens: 128_000, provenance: "probed" });
    expect(d.fit.verdict).toBe("fits");
    expect(d.fit.requestTokens).toBe(d.fit.systemTokens + d.fit.toolTokens + d.fit.messageTokens);
    expect(r.tools).toHaveLength(1);
  });

  it("too big on a MEASURED window → refuse, message names every component, request untouched", () => {
    mockWindow.mockReturnValue({ tokens: 8_192, provenance: "probed" });
    const r = req([bigTool(36_000)]);
    const d = assessOpenAiCompatPreflight({ model: "google/gemma-4-e4b", req: r });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.message).toContain("8,192");
      expect(d.message).toContain("google/gemma-4-e4b");
      expect(d.message).toMatch(/system prompt ~[\d,]+/);
      expect(d.message).toMatch(/tools ~[\d,]+/);
      expect(d.message).toMatch(/messages ~[\d,]+/);
    }
    expect(d.fit.verdict).toBe("too_big");
    expect(r.tools).toHaveLength(1);
  });

  it("too big on a FLOOR window → send anyway (a guess is never grounds for refusal)", () => {
    mockWindow.mockReturnValue({ tokens: 8_192, provenance: "floor" });
    const r = req([bigTool(36_000)]);
    const d = assessOpenAiCompatPreflight({ model: "qwen3.6:27b", req: r });
    expect(d.kind).toBe("send");
    expect(d.fit.verdict).toBe("too_big");
    expect(d.window.provenance).toBe("floor");
    expect(r.tools).toHaveLength(1);
  });

  it("exact and heuristic provenance refuse like probed — only floor is exempt", () => {
    for (const provenance of ["exact", "heuristic"] as const) {
      mockWindow.mockReturnValue({ tokens: 8_192, provenance });
      expect(assessOpenAiCompatPreflight({ model: "m", req: req([bigTool(36_000)]) }).kind).toBe("refuse");
    }
  });
});
