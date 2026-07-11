/**
 * Pins the reasoning.effort seam in buildRequestBody: the user-selected
 * thinking depth (settings.reasoningEffort → Think picker) must reach the
 * Responses API body verbatim, and the absence of a selection must keep the
 * long-standing "medium" default (high timed out, low emptied ~40% of turns).
 */
import { describe, expect, it } from "vitest";
import { buildRequestBody } from "./request.js";

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

  it("sends the user-selected effort verbatim, including xhigh (Max)", () => {
    for (const effort of ["minimal", "low", "high", "xhigh"] as const) {
      const body = buildRequestBody({ ...BASE, reasoningEffort: effort });
      expect(body.reasoning).toEqual({ effort, summary: "auto" });
    }
  });
});
