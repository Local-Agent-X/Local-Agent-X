import { describe, expect, it } from "vitest";
import { configSchema } from "./config-schema.js";
import { FLIPPABLE_SETTINGS, isProtectedSetting } from "./settings-schema.js";

describe("learning mode settings contract", () => {
  it("defaults to assisted mode", () => {
    expect(configSchema.parse({}).learningMode).toBe("assisted");
  });

  it("is runtime-bound, broadcast, and user-protected", () => {
    const setting = FLIPPABLE_SETTINGS.find((entry) => entry.field === "learningMode");
    expect(setting).toMatchObject({ runtime: true, broadcast: true, protected: true });
    expect(isProtectedSetting("learningMode")).toBe(true);
    expect(setting?.validate.safeParse("autonomous").success).toBe(true);
    expect(setting?.validate.safeParse("silent").success).toBe(false);
  });
});

describe("skill review settings contract", () => {
  it("is on by default and is its own field, not a learningMode value", () => {
    expect(configSchema.parse({}).skillReviewEnabled).toBe(true);
    expect(configSchema.parse({ learningMode: "autonomous", skillReviewEnabled: false })).toMatchObject({ learningMode: "autonomous", skillReviewEnabled: false });
  });

  it("is runtime-bound, broadcast, and user-protected", () => {
    const setting = FLIPPABLE_SETTINGS.find((entry) => entry.field === "skillReviewEnabled");
    expect(setting).toMatchObject({ runtime: true, broadcast: true, protected: true });
    expect(isProtectedSetting("skillReviewEnabled")).toBe(true);
    expect(setting?.validate.safeParse(false).success).toBe(true);
    expect(setting?.validate.safeParse("off").success).toBe(false);
  });
});
