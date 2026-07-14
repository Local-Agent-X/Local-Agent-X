import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the canonical LLM chokepoint (classifySchema routes through it) so the
// default wiring path is testable without a provider. The mock resolves the
// RAW model text — classifySchema owns fence-strip → JSON.parse → zod.
const classifyMock = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>): Promise<string | null> =>
    '{"decision":"REDIRECT","reason":"it\'s feedback"}'),
);
vi.mock("../classifiers/classify-with-llm.js", () => ({ classifyWithLLM: classifyMock }));

import { classifyWorkerRedirect } from "./worker-redirect-classifier.js";

type Llm = (system: string, user: string) => Promise<string | null>;
const llmReturning = (...replies: (string | null)[]) => {
  const fn = vi.fn<Llm>();
  for (const r of replies) fn.mockResolvedValueOnce(r);
  return fn;
};

describe("classifyWorkerRedirect — schema-validated verdict", () => {
  beforeEach(() => classifyMock.mockClear());

  it("short confirmations skip the LLM and stay with the main agent", async () => {
    const r = await classifyWorkerRedirect("ok", "task", []);
    expect(r?.redirect).toBe(false);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("very long messages skip the LLM and stay with the main agent", async () => {
    const r = await classifyWorkerRedirect("x".repeat(2001), "task", []);
    expect(r?.redirect).toBe(false);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("routes through the canonical classifier — no Anthropic-only gate", async () => {
    const r = await classifyWorkerRedirect("make the header blue instead of red", "build a site", []);
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(classifyMock.mock.calls[0][0]).toMatchObject({ category: "worker-redirect" });
    expect(r).toMatchObject({ redirect: true, reason: "it's feedback" });
  });

  it("a valid MAIN_AGENT verdict maps to redirect:false (via _llm injection)", async () => {
    const llm = llmReturning('{"decision":"MAIN_AGENT","reason":"unrelated"}');
    const r = await classifyWorkerRedirect("what's the weather like", "build a site", [], undefined, llm);
    expect(r).toMatchObject({ redirect: false, reason: "unrelated" });
    expect(llm).toHaveBeenCalledTimes(1);
    // Decision semantics + recent-chat rule still ride the system prompt.
    expect(llm.mock.calls[0][0]).toContain("REDIRECT");
    expect(llm.mock.calls[0][0]).toContain("Recent main-agent chat");
  });

  it("a missing reason gets the placeholder, not a void verdict", async () => {
    const llm = llmReturning('{"decision":"REDIRECT"}');
    const r = await classifyWorkerRedirect("use orange not red", "build a site", [], undefined, llm);
    expect(r).toMatchObject({ redirect: true, reason: "(no reason given)" });
  });

  it("an invalid decision is retried once, then null (caller defaults to MAIN_AGENT)", async () => {
    const llm = llmReturning('{"decision":"BOTH","reason":"?"}', "still not json");
    const r = await classifyWorkerRedirect("use orange not red", "build a site", [], undefined, llm);
    expect(r).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("LLM unavailable → null without a retry", async () => {
    const llm = llmReturning(null);
    const r = await classifyWorkerRedirect("use orange not red", "build a site", [], undefined, llm);
    expect(r).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("recent main-agent turns ride into the user prompt for short-reply disambiguation", async () => {
    const llm = llmReturning('{"decision":"MAIN_AGENT","reason":"answers the main agent"}');
    await classifyWorkerRedirect(
      "the second one",
      "build a site",
      [{ role: "assistant", content: "Which font do you prefer: Inter or Geist?" }],
      undefined,
      llm,
    );
    const user = llm.mock.calls[0][1];
    expect(user).toContain("Recent main-agent chat");
    expect(user).toContain("Which font do you prefer");
    expect(user).toContain("the second one");
  });
});
