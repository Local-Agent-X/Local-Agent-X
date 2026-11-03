import { beforeEach, describe, expect, it, vi } from "vitest";

const classifyFollowupWithLLM = vi.fn();
const batchedTopicalRelevance = vi.fn();
vi.mock("../classifiers/followup-classify.js", () => ({ classifyFollowupWithLLM }));
vi.mock("../classifiers/topical-relevance.js", () => ({ batchedTopicalRelevance }));

const { applyBleedGate, classifyVerdict } = await import("./bleed-gate.js");
import type { OrchestratorInput } from "./types.js";

function input(message: string, keywordGates?: boolean): OrchestratorInput {
  return {
    message,
    sessionId: "voice-1",
    sessionMessages: [{ role: "user", content: "help me plan the kraken bot release" }],
    timeOfDay: 12,
    dayOfWeek: 1,
    agentPreviousMessage: "Sure, what part first?",
    ...(keywordGates ? { keywordGates } : {}),
  };
}

// "inside-references" is a session-scope module; an unknown source is profile.
const signals = [
  { source: "inside-references", signal: "kraken bot release notes drafted last week" },
  { source: "inside-references", signal: "grocery list for the weekend" },
  { source: "profile-thing", signal: "user prefers short answers" },
];

describe("bleed gate — a spoken turn judges memory relevance without a model call", () => {
  beforeEach(() => {
    classifyFollowupWithLLM.mockReset().mockResolvedValue("followup");
    batchedTopicalRelevance.mockReset().mockResolvedValue({ relevantIndices: new Set([1]) });
  });

  it("asks the model whether a typed turn is a follow-up", async () => {
    expect(await classifyVerdict(input("schedule the kraken bot release tomorrow"), "")).toBe("followup");
    expect(classifyFollowupWithLLM).toHaveBeenCalledTimes(1);
  });

  it("gives a keyword-gated turn the keyword verdict, with no model call", async () => {
    expect(await classifyVerdict(input("schedule the kraken bot release tomorrow", true), "")).toBe("new");
    expect(await classifyVerdict(input("ok", true), "")).toBe("followup");
    expect(classifyFollowupWithLLM).not.toHaveBeenCalled();
  });

  it("filters a keyword-gated turn's session signals by keyword overlap, with no model call", async () => {
    const kept = await applyBleedGate(signals, "new", input("schedule the kraken bot release tomorrow", true), "");
    expect(kept.map((s) => s.signal)).toEqual([
      "user prefers short answers",
      "kraken bot release notes drafted last week",
    ]);
    const resumed = await applyBleedGate(signals, "resume", input("go", true), "help me plan the kraken bot release");
    expect(resumed.map((s) => s.signal)).toEqual(["kraken bot release notes drafted last week"]);
    expect(batchedTopicalRelevance).not.toHaveBeenCalled();
  });

  it("lets the model pick a typed turn's relevant session signals", async () => {
    const kept = await applyBleedGate(signals, "new", input("schedule the kraken bot release tomorrow"), "");
    expect(kept.map((s) => s.signal)).toEqual(["user prefers short answers", "grocery list for the weekend"]);
    expect(batchedTopicalRelevance).toHaveBeenCalledTimes(1);
  });

  it("falls back to keyword overlap when the model gives no verdict", async () => {
    batchedTopicalRelevance.mockResolvedValue(null);
    const kept = await applyBleedGate(signals, "new", input("schedule the kraken bot release tomorrow"), "");
    expect(kept.map((s) => s.signal)).toEqual([
      "user prefers short answers",
      "kraken bot release notes drafted last week",
    ]);
  });
});
