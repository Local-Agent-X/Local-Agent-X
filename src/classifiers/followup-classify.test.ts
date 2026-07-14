import { describe, it, expect, vi, beforeEach } from "vitest";

// classifySchema routes through the canonical chokepoint; the mock resolves
// RAW model text so the real fence-strip → JSON.parse → zod pipeline runs.
const classifyMock = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>): Promise<string | null> => null),
);
vi.mock("./classify-with-llm.js", () => ({ classifyWithLLM: classifyMock }));

import { classifyFollowupWithLLM } from "./followup-classify.js";

type Llm = (system: string, user: string) => Promise<string | null>;
const llmReturning = (...replies: (string | null)[]) => {
  const fn = vi.fn<Llm>();
  for (const r of replies) fn.mockResolvedValueOnce(r);
  return fn;
};

describe("classifyFollowupWithLLM — schema-validated verdict", () => {
  beforeEach(() => classifyMock.mockClear());

  it.each([
    ['{"verdict":"FOLLOWUP","reason":"short ack"}', "followup"],
    ['{"verdict":"RESUME","reason":"continues the paused task"}', "resume"],
    ['{"verdict":"NEW","reason":"names a new topic"}', "new"],
  ])("maps %s → %s", async (reply, expected) => {
    const llm = llmReturning(reply);
    const v = await classifyFollowupWithLLM("im logged in go", "please log in", { _llm: llm });
    expect(v).toBe(expected);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("an off-vocabulary verdict is retried once, then null (caller keeps its regex verdict)", async () => {
    const llm = llmReturning('{"verdict":"MAYBE","reason":"?"}', "not json either");
    expect(await classifyFollowupWithLLM("ok", "done!", { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("LLM unavailable → null without a retry", async () => {
    const llm = llmReturning(null);
    expect(await classifyFollowupWithLLM("ok", "done!", { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("anchor, prior turn, and current message all ride the user prompt", async () => {
    const llm = llmReturning('{"verdict":"RESUME","reason":"user finished the out-of-band step"}');
    await classifyFollowupWithLLM("im logged in go", "please log in to the PO portal", {
      firstUserMessage: "enter the pending purchase orders",
      _llm: llm,
    });
    const user = llm.mock.calls[0][1];
    expect(user).toContain("enter the pending purchase orders");
    expect(user).toContain("please log in to the PO portal");
    expect(user).toContain("im logged in go");
  });

  it("default wiring goes through the canonical chokepoint with the followup category + env flag", async () => {
    classifyMock.mockResolvedValueOnce('{"verdict":"NEW","reason":"substantive"}');
    const v = await classifyFollowupWithLLM("what is webrtc", "hello!");
    expect(v).toBe("new");
    const opts = classifyMock.mock.calls[0][0];
    expect(opts).toMatchObject({ category: "followup", envDisableVar: "LAX_LLM_FOLLOWUP" });
  });
});
