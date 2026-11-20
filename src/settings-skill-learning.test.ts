import { describe, expect, it } from "vitest";
import { configSchema } from "./config-schema.js";
import { FLIPPABLE_SETTINGS, isProtectedSetting } from "./settings-schema.js";

describe("skill review settings contract", () => {
  it("is on by default", () => {
    expect(configSchema.parse({}).skillReviewEnabled).toBe(true);
    expect(configSchema.parse({ skillReviewEnabled: false }).skillReviewEnabled).toBe(false);
  });

  it("drops a learningMode left in an older config", () => {
    expect(configSchema.parse({ learningMode: "autonomous" })).not.toHaveProperty("learningMode");
  });

  it("is runtime-bound, broadcast, and user-protected", () => {
    const setting = FLIPPABLE_SETTINGS.find((entry) => entry.field === "skillReviewEnabled");
    expect(setting).toMatchObject({ runtime: true, broadcast: true, owner: "protected" });
    expect(isProtectedSetting("skillReviewEnabled")).toBe(true);
    expect(setting?.validate.safeParse(false).success).toBe(true);
    expect(setting?.validate.safeParse("off").success).toBe(false);
  });
});

describe("failure review settings contract", () => {
  it("is on by default and is its own field, not the skill review's", () => {
    expect(configSchema.parse({}).failureReviewEnabled).toBe(true);
    expect(configSchema.parse({ skillReviewEnabled: true, failureReviewEnabled: false })).toMatchObject({ skillReviewEnabled: true, failureReviewEnabled: false });
  });

  it("is runtime-bound, broadcast, and user-protected", () => {
    const setting = FLIPPABLE_SETTINGS.find((entry) => entry.field === "failureReviewEnabled");
    expect(setting).toMatchObject({ runtime: true, broadcast: true, owner: "protected" });
    expect(isProtectedSetting("failureReviewEnabled")).toBe(true);
    expect(setting?.validate.safeParse(false).success).toBe(true);
    expect(setting?.validate.safeParse("off").success).toBe(false);
  });
});
