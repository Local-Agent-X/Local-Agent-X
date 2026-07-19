import { describe, expect, it } from "vitest";
import { explicitTargetPin } from "./target-pin.js";

describe("explicitTargetPin", () => {
  it("keeps the original requested target when current resolution falls back", () => {
    const currentTarget = { provider: "openai", model: "gpt-4o-mini" };
    const pin = explicitTargetPin("anthropic", "claude-opus-4-8");

    expect(pin).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(pin).not.toEqual(currentTarget);
  });

  it("does not create a pin without an explicit override", () => {
    expect(explicitTargetPin(undefined, undefined)).toBeUndefined();
    expect(explicitTargetPin("invalid", " ")).toBeUndefined();
  });
});
