/**
 * curate-classifier — schema-validated teach-moment detection.
 *
 * All model calls are injected via the classifySchema `_llm` seam; no test
 * touches the network. Locks in: valid parse + kind→NudgeTrigger collapse,
 * tolerant degrade of the non-load-bearing fields (teach/confidence/why),
 * strict rejection of an off-vocabulary kind (single retry → null), and the
 * null → "no boost" fallback contract on garbage/unavailable replies.
 */
import { describe, it, expect, vi } from "vitest";
import { classifyTeachMoment } from "./curate-classifier.js";

type Llm = (systemPrompt: string, userPrompt: string) => Promise<string | null>;

const MSG = "you need to toggle to instagram view for those stats";
const PREV = "Here are your Facebook page stats for the week.";

describe("classifyTeachMoment — schema-validated path (injected _llm)", () => {
  it("accepts a valid reply and collapses the kind to its NudgeTrigger", async () => {
    const llm = vi.fn<Llm>(async () =>
      `{"teach": true, "kind": "correction", "confidence": 0.85, "why": "user redirected the agent"}`);
    await expect(classifyTeachMoment(MSG, PREV, llm)).resolves.toEqual({
      teach: true,
      kind: "correction-detected",
      confidence: 0.85,
      why: "user redirected the agent",
    });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("collapses workflow/fact to preference-stated and keeps explicit-remember", async () => {
    const wf = vi.fn<Llm>(async () => `{"teach":true,"kind":"workflow","confidence":0.9,"why":"w"}`);
    await expect(classifyTeachMoment(MSG, PREV, wf)).resolves.toMatchObject({ kind: "preference-stated" });
    const er = vi.fn<Llm>(async () => `{"teach":true,"kind":"Explicit-Remember","confidence":0.9,"why":"e"}`);
    // kind is case-normalized before the enum, mirroring the old parser.
    await expect(classifyTeachMoment(MSG, PREV, er)).resolves.toMatchObject({ kind: "explicit-remember" });
  });

  it("teach=false (or kind none) yields kind 'none'", async () => {
    const llm = vi.fn<Llm>(async () => `{"teach": false, "kind": "none", "confidence": 0.2, "why": "routine"}`);
    await expect(classifyTeachMoment(MSG, PREV, llm)).resolves.toEqual({
      teach: false,
      kind: "none",
      confidence: 0.2,
      why: "routine",
    });
  });

  it("degrades sloppy non-load-bearing fields instead of burning the retry", async () => {
    // teach non-boolean → false; confidence out of range → clamped; why long → sliced.
    const llm = vi.fn<Llm>(async () =>
      `{"teach": "yes", "kind": "preference", "confidence": 1.7, "why": "${"w".repeat(300)}"}`);
    const result = await classifyTeachMoment(MSG, PREV, llm);
    expect(result).toMatchObject({ teach: false, kind: "none", confidence: 1 });
    expect(result?.why).toHaveLength(120);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("an off-vocabulary kind is rejected — single retry with error feedback, then null", async () => {
    const llm = vi.fn<Llm>(async () => `{"teach": true, "kind": "observation", "confidence": 0.8, "why": "x"}`);
    await expect(classifyTeachMoment(MSG, PREV, llm)).resolves.toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][1]).toContain("Your previous reply was invalid:");
  });

  it("garbage reply → null → caller's 'no boost' fallback", async () => {
    const llm = vi.fn<Llm>(async () => "This seems like a teaching moment to me!");
    await expect(classifyTeachMoment(MSG, PREV, llm)).resolves.toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("LLM unavailable (null) → null without a retry", async () => {
    const llm = vi.fn<Llm>(async () => null);
    await expect(classifyTeachMoment(MSG, PREV, llm)).resolves.toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("length gates skip the model entirely: tiny acks and huge pastes", async () => {
    const llm = vi.fn<Llm>(async () => `{"teach":true,"kind":"fact","confidence":1,"why":"x"}`);
    await expect(classifyTeachMoment("ok", PREV, llm)).resolves.toBeNull();
    await expect(classifyTeachMoment("x".repeat(4001), PREV, llm)).resolves.toBeNull();
    expect(llm).not.toHaveBeenCalled();
  });
});
