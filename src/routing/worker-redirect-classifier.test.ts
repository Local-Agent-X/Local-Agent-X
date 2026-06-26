import { describe, it, expect, vi, beforeEach } from "vitest";

const classifyMock = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => ({
  redirect: true, reason: "r", raw: "DECISION: REDIRECT",
})));
vi.mock("../classifiers/classify-with-llm.js", () => ({ classifyWithLLM: classifyMock }));

import { classifyWorkerRedirect, parseWorkerRedirect } from "./worker-redirect-classifier.js";

describe("parseWorkerRedirect", () => {
  it("parses REDIRECT + reason", () => {
    expect(parseWorkerRedirect("DECISION: REDIRECT\nREASON: it's feedback")).toMatchObject({
      redirect: true, reason: "it's feedback",
    });
  });
  it("parses MAIN_AGENT", () => {
    expect(parseWorkerRedirect("DECISION: MAIN_AGENT\nREASON: unrelated")?.redirect).toBe(false);
  });
  it("returns null with no DECISION line", () => {
    expect(parseWorkerRedirect("I think this is feedback")).toBeNull();
  });
});

describe("classifyWorkerRedirect", () => {
  beforeEach(() => classifyMock.mockClear());

  it("short confirmations skip the LLM and stay with the main agent", async () => {
    const r = await classifyWorkerRedirect("ok", "task", []);
    expect(r?.redirect).toBe(false);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("routes through the canonical classifier — no Anthropic-only gate", async () => {
    await classifyWorkerRedirect("make the header blue instead of red", "build a site", []);
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(classifyMock.mock.calls[0][0]).toMatchObject({ category: "worker-redirect" });
  });
});
