import { describe, it, expect } from "vitest";
import { READ_ONLY_ACTIONS } from "./action-tables.js";
import { ANDROID_TOOL_PARAMETERS } from "./description.js";

const ALL_ACTIONS = (ANDROID_TOOL_PARAMETERS.properties.action as { enum: string[] }).enum;

describe("android action-tables", () => {
  it("every action in the schema enum is classified exactly once (read-only or not)", () => {
    for (const action of ALL_ACTIONS) {
      expect(typeof READ_ONLY_ACTIONS.has(action)).toBe("boolean");
    }
  });

  it("read-only actions are exactly the ones with no device-mutating side effect", () => {
    expect(READ_ONLY_ACTIONS.has("list_devices")).toBe(true);
    expect(READ_ONLY_ACTIONS.has("screenshot")).toBe(true);
    expect(READ_ONLY_ACTIONS.has("list_apps")).toBe(true);
  });

  it("mutating actions are NOT classified read-only", () => {
    for (const action of ["start_emulator", "stop_emulator", "tap", "swipe", "type_text", "key_event", "install_apk", "launch_app"]) {
      expect(READ_ONLY_ACTIONS.has(action)).toBe(false);
    }
  });
});
