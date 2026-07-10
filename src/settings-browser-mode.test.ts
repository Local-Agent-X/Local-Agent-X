import { describe, expect, it } from "vitest";
import { BROADCAST_KEYS, PROTECTED_SETTINGS, RUNTIME_SETTINGS, publicSchema } from "./settings-schema.js";
import { settingTool } from "./tools/setting-tool.js";

describe("browserMode settings contract", () => {
  it("is the sole protected runtime browser identity setting", () => {
    const field = publicSchema().find((entry) => entry.field === "browserMode");
    expect(field).toMatchObject({
      type: "enum",
      values: ["isolated", "continuity", "advanced-shared"],
      runtime: true,
    });
    expect(RUNTIME_SETTINGS.some((entry) => entry.field === "browserMode")).toBe(true);
    expect(BROADCAST_KEYS.has("browserMode")).toBe(true);
    expect(PROTECTED_SETTINGS.has("browserMode")).toBe(true);
    expect(publicSchema().some((entry) => entry.field === "browserPerSessionContext")).toBe(false);
  });

  it("is discoverable with enum values through the setting tool", async () => {
    const result = await settingTool.execute({ field: "?", value: null });
    expect(result.content).toContain("browserMode (isolated|continuity|advanced-shared)");
  });
});
