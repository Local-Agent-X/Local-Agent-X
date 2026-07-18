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
