/**
 * Pins the three registration sites a new tool must hit in this repo (see
 * AGENTS.md / feedback_tool_registration_checklist): plugin registration,
 * the tool-policy table, and the ARI action map. Modeled on
 * browser-tools/registration.test.ts, scoped to what `android` actually has.
 */
import { describe, expect, it } from "vitest";
import { ANDROID_TOOL_NAME, ANDROID_TOOL_DESCRIPTION, ANDROID_TOOL_PARAMETERS } from "./description.js";
import { createAndroidTools } from "./index.js";
import { plugins } from "../plugins.js";
import { deriveAriAction } from "../../tool-execution/ari-action-map.js";
import { TOOL_POLICIES_APPS } from "../../tool-policy/tool-policies.apps.js";
import { TOOLS } from "../../tool-registry.js";

const actionEnum = (ANDROID_TOOL_PARAMETERS.properties.action as { enum: string[] }).enum;

describe("android tool registration", () => {
  it("1. is registered as a plugin", () => {
    expect(plugins.some((p) => p.id === "android")).toBe(true);
  });

  it("2. createAndroidTools() produces exactly the `android` tool", () => {
    const tools = createAndroidTools();
    expect(tools.map((t) => t.name)).toEqual([ANDROID_TOOL_NAME]);
  });

  it("3. every action is described to the model", () => {
    for (const action of actionEnum) {
      expect(ANDROID_TOOL_DESCRIPTION).toContain(`- ${action}:`);
    }
  });

  it("4. has a tool-policy entry with an explicit allow rule (default-deny invariant)", () => {
    const entry = TOOL_POLICIES_APPS.android;
    expect(entry).toBeDefined();
    expect(entry.kernel).toBe("shell");
    const allow = entry.rules?.find((r) => r.decision === "allow" && !("action" in r));
    expect(allow).toBeDefined();
  });

  it("5. is projected into the concrete tool taxonomy (TOOLS)", () => {
    expect(TOOLS.android).toEqual({ kernel: "shell", risk: "shell" });
  });

  it("6. maps to a schema-valid action for the shell kernel class", () => {
    expect(deriveAriAction("android", { action: "tap" })).toBe("exec");
  });

  it("7. install_apk's apk_path is declared as a gated path arg (file-access confinement), unconditionally so other actions aren't fail-closed out", () => {
    const pathArgs = TOOL_POLICIES_APPS.android.pathArgs ?? [];
    const apkArg = pathArgs.find((p) => p.arg === "apk_path");
    expect(apkArg).toBeDefined();
    expect(apkArg?.forActions).toBeUndefined();
  });
});
