import { describe, it, expect, vi, beforeEach } from "vitest";

// classifySchema routes through the canonical chokepoint; the mock resolves
// RAW model text so the real JSON.parse → zod (discriminated union) runs.
const classifyWithLLM = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>): Promise<string | null> => null),
);
vi.mock("./classify-with-llm.js", () => ({
  classifyWithLLM: (...args: unknown[]) => classifyWithLLM(...(args as [Record<string, unknown>])),
}));

const { classifyAppTierEscalation } = await import("./app-tier-classify.js");
const { resolveAppTier } = await import("../tools/app-tier.js");

type Llm = (system: string, user: string) => Promise<string | null>;
const llmReturning = (...replies: (string | null)[]) => {
  const fn = vi.fn<Llm>();
  for (const r of replies) fn.mockResolvedValueOnce(r);
  return fn;
};

beforeEach(() => classifyWithLLM.mockReset());

describe("classifyAppTierEscalation — schema-validated union verdict", () => {
  it("a tier reply resolves to the bare tier token", async () => {
    const llm = llmReturning('{"kind":"tier","tier":"full-stack","reason":"shared reservations db"}');
    const verdict = await classifyAppTierEscalation({
      prompt: "a booking system for my car wash where customers reserve slots",
      _llm: llm,
    });
    expect(verdict).toBe("full-stack");
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("a well-formed clarify reply resolves to a clarify verdict", async () => {
    const llm = llmReturning(
      '{"kind":"clarify","question":"What do you mean by a mega computer?","options":["A retro-computer web app","A simulated CPU in code","A real PC parts list"]}',
    );
    const verdict = await classifyAppTierEscalation({ prompt: "build me a mega computer", _llm: llm });
    expect(verdict).toEqual({
      kind: "clarify",
      question: "What do you mean by a mega computer?",
      options: ["A retro-computer web app", "A simulated CPU in code", "A real PC parts list"],
    });
  });

  it("caps clarify options at 4", async () => {
    const llm = llmReturning('{"kind":"clarify","question":"Q","options":["a","b","c","d","e"]}');
    const verdict = await classifyAppTierEscalation({ prompt: "build me a thing", _llm: llm });
    expect(verdict).toMatchObject({ kind: "clarify", question: "Q", options: ["a", "b", "c", "d"] });
  });

  it("rejects a malformed clarify (missing question or < 2 options) so the caller builds", async () => {
    for (const bad of [
      '{"kind":"clarify"}',
      '{"kind":"clarify","question":"only a question","options":[]}',
      '{"kind":"clarify","question":"q","options":["just-one-option"]}',
    ]) {
      const llm = llmReturning(bad, bad); // invalid on both attempts
      expect(await classifyAppTierEscalation({ prompt: "x", _llm: llm })).toBeNull();
      expect(llm).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects a non-tier token after the single retry", async () => {
    const llm = llmReturning('{"kind":"tier","tier":"static-page"}', "MAYBE full-stack?");
    expect(await classifyAppTierEscalation({ prompt: "a tip calculator", _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("passes the brief through the chokepoint with the app-tier env flag", async () => {
    classifyWithLLM.mockResolvedValue('{"kind":"tier","tier":"full-stack","reason":"r"}');
    const verdict = await classifyAppTierEscalation({
      prompt: "a booking system for my car wash where customers reserve slots",
    });
    expect(verdict).toBe("full-stack");
    const opts = classifyWithLLM.mock.calls[0][0];
    expect(opts.category).toBe("app-tier");
    expect(opts.envDisableVar).toBe("LAX_LLM_APP_TIER");
    expect(opts.userPrompt).toContain("car wash");
  });

  it("returns null when the LLM is unavailable (caller keeps the regex verdict)", async () => {
    classifyWithLLM.mockResolvedValue(null);
    expect(await classifyAppTierEscalation({ prompt: "a tip calculator" })).toBeNull();
    expect(classifyWithLLM).toHaveBeenCalledTimes(1); // unavailable is never retried
  });
});

describe("resolveAppTier — escalation-only hybrid", () => {
  it("trusts regex hard signals without consulting the LLM", async () => {
    classifyWithLLM.mockResolvedValue('{"kind":"tier","tier":"quick-html"}');
    expect(await resolveAppTier("build a rust raytracer")).toBe("compiled-native");
    expect(classifyWithLLM).not.toHaveBeenCalled();
  });

  it("escalates the quick-html residue on an LLM verdict", async () => {
    classifyWithLLM.mockResolvedValue('{"kind":"tier","tier":"full-stack","reason":"r"}');
    expect(await resolveAppTier("a booking system for my car wash")).toBe("full-stack");
  });

  it("keeps the regex verdict on LLM outage — never downgrades toward faking", async () => {
    classifyWithLLM.mockResolvedValue(null);
    expect(await resolveAppTier("a tip calculator")).toBe("quick-html");
  });

  it("surfaces a clarify verdict from the quick-html residue instead of a tier", async () => {
    classifyWithLLM.mockResolvedValue(
      '{"kind":"clarify","question":"What do you mean by a mega computer?","options":["A retro-computer web app","A real PC parts list"]}',
    );
    expect(await resolveAppTier("build me a mega computer")).toEqual({
      kind: "clarify",
      question: "What do you mean by a mega computer?",
      options: ["A retro-computer web app", "A real PC parts list"],
    });
  });
});
