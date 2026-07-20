/**
 * Contract tests for the kill-switch gate registry — the invariants that fix
 * the 2026-07-20 failure class (blocked agent chased the wrong layer because
 * one gate's recovery text omitted the `setting` affordance):
 *
 *  1. Every gate's recovery names the `setting` tool AND its exact field.
 *  2. Every gate's field exists in FLIPPABLE_SETTINGS as protected:true
 *     (so "call `setting`" is safe advice — flips route through approval).
 *  3. Every "Category kill-switch" setting in the schema has a gate here —
 *     a new kill-switch setting cannot ship without a dispatch gate + affordance.
 *  4. The App-Map security line derives from the schema (no hand-typed drift).
 */
import { describe, it, expect } from "vitest";
import { KILL_SWITCH_GATES, killSwitchBlock } from "./kill-switch-gates.js";
import { FLIPPABLE_SETTINGS, PROTECTED_SETTINGS } from "../settings-schema.js";
import { securitySettingsLine } from "../manifest-generator/summary.js";
import { USER_HINTS } from "../types.js";

const ALL_ON = {
  enableShell: true,
  enableHttp: true,
  enableBrowser: true,
  enableComputerControl: true,
} as const;

describe("kill-switch gate registry contract", () => {
  it("every gate's recovery names the `setting` tool and the exact field", () => {
    for (const gate of KILL_SWITCH_GATES) {
      const block = killSwitchBlock(
        sampleToolFor(gate.field),
        { ...ALL_ON, [gate.field]: false },
      );
      expect(block, `gate ${gate.field} should block its own tool`).not.toBeNull();
      expect(block!.recovery).toContain("`setting`");
      expect(block!.recovery).toContain(`${gate.field}=true`);
      // The wrong-layer warning that stops the /api/tool-policy/toggle chase.
      expect(block!.recovery).toMatch(/tool-policy/i);
      expect(block!.reason).toMatch(/disabled in Settings → Security/);
    }
  });

  it("every gate field is a protected FLIPPABLE_SETTINGS entry", () => {
    for (const gate of KILL_SWITCH_GATES) {
      const spec = FLIPPABLE_SETTINGS.find((s) => s.field === gate.field);
      expect(spec, `${gate.field} must exist in FLIPPABLE_SETTINGS`).toBeDefined();
      expect(spec!.protected, `${gate.field} must be protected (approval-routed)`).toBe(true);
      expect(spec!.runtime, `${gate.field} must be runtime-mirrored`).toBe(true);
    }
  });

  it("every 'Category kill-switch' setting in the schema has a dispatch gate", () => {
    // Keyed on the schema's own description convention: tool-category
    // kill-switches say "Category kill-switch" (enableRemoteControl gates the
    // human input pump, not tool dispatch, and deliberately doesn't).
    const schemaKillSwitches = FLIPPABLE_SETTINGS
      .filter((s) => s.description.startsWith("Category kill-switch"))
      .map((s) => s.field);
    const gated = new Set<string>(KILL_SWITCH_GATES.map((g) => g.field));
    for (const field of schemaKillSwitches) {
      expect(gated.has(field), `schema kill-switch ${field} has no dispatch gate`).toBe(true);
    }
    // And the inverse: no gate for a field the schema doesn't call a kill-switch.
    expect([...gated].sort()).toEqual([...schemaKillSwitches].sort());
  });

  it("gates fail open on absent config fields (matches historic === false checks)", () => {
    expect(killSwitchBlock("bash", {})).toBeNull();
    expect(killSwitchBlock("computer", {})).toBeNull();
  });

  it("non-matching tools pass even with every switch off", () => {
    const allOff = {
      enableShell: false,
      enableHttp: false,
      enableBrowser: false,
      enableComputerControl: false,
    };
    expect(killSwitchBlock("read", allOff)).toBeNull();
    expect(killSwitchBlock("write", allOff)).toBeNull();
    expect(killSwitchBlock("setting", allOff)).toBeNull();
  });

  it("shell gate covers the process_* family", () => {
    const block = killSwitchBlock("process_start", { ...ALL_ON, enableShell: false });
    expect(block?.field).toBe("enableShell");
  });

  it("USER_HINTS.killSwitch exists and points at Settings → Security, not tool-policy.json", () => {
    expect(USER_HINTS.killSwitch).toContain("Settings → Security");
    expect(USER_HINTS.killSwitch).not.toContain("tool-policy.json");
  });
});

describe("App-Map security-settings line derives from the schema", () => {
  it("lists every protected field — including enableComputerControl", () => {
    const line = securitySettingsLine();
    for (const field of PROTECTED_SETTINGS) {
      expect(line, `App-Map line must mention ${field}`).toContain(field);
    }
    expect(line).toContain("`setting`");
  });
});

function sampleToolFor(field: string): string {
  switch (field) {
    case "enableShell": return "bash";
    case "enableHttp": return "http_request";
    case "enableBrowser": return "browser";
    case "enableComputerControl": return "computer";
    default: throw new Error(`no sample tool for ${field}`);
  }
}
