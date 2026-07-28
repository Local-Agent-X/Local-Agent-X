import { describe, expect, it } from "vitest";
import {
  REASONING_EFFORTS,
  capEffort,
  effortForChatCompletions,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "./reasoning-effort.js";

describe("reasoning-effort helpers", () => {
  it("normalizes unknown settings values to medium", () => {
    expect(normalizeReasoningEffort(undefined)).toBe("medium");
    expect(normalizeReasoningEffort("MAX")).toBe("medium");
    expect(normalizeReasoningEffort("xhigh")).toBe("xhigh");
  });

  it("clamps xhigh to high for Chat Completions, passes the rest through", () => {
    expect(effortForChatCompletions("xhigh")).toBe("high");
    expect(effortForChatCompletions("minimal")).toBe("minimal");
    expect(effortForChatCompletions("medium")).toBe("medium");
  });

  it("capEffort is min() over the REASONING_EFFORTS order — full table", () => {
    const idx = (e: ReasoningEffort) => REASONING_EFFORTS.indexOf(e);
    for (const effort of REASONING_EFFORTS) {
      for (const ceiling of REASONING_EFFORTS) {
        const expected = idx(effort) <= idx(ceiling) ? effort : ceiling;
        expect(capEffort(effort, ceiling), `capEffort(${effort}, ${ceiling})`).toBe(expected);
      }
    }
  });

  it("capEffort never returns a value above the input effort", () => {
    expect(capEffort("xhigh", "low")).toBe("low");
    expect(capEffort("minimal", "low")).toBe("minimal"); // no up-shift to the ceiling
    expect(capEffort("low", "low")).toBe("low");
  });
});
