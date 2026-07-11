import { describe, expect, it } from "vitest";
import { effortForChatCompletions, normalizeReasoningEffort } from "./reasoning-effort.js";

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
});
