import { describe, it, expect } from "vitest";
import { configSchema } from "../config-schema.js";
import { FLIPPABLE_SETTINGS } from "../settings-schema.js";
import { TIERS, VOICE_COMMAND_TIER_MAP, tierById } from "../routes/bridges/voice-setup/tiers.js";

// GPT-SoVITS was removed as a voice-clone engine (2026-07): Chatterbox is
// the only clone tier, with Lite's built-in Kokoro as the backup. These
// tests lock the removal so a stale config value can't brick config
// parsing, the two schemas that validate the same persisted value can't
// drift, and the /voice bridge command can't point at tier ids that don't
// exist (which is exactly how it was broken before).

const settingsValidate = () => {
  const entry = FLIPPABLE_SETTINGS.find(s => s.field === "bridgeVoicePreference");
  expect(entry).toBeDefined();
  return entry!.validate;
};

describe("bridgeVoicePreference after sovits removal", () => {
  const field = configSchema.shape.bridgeVoicePreference;

  it("coerces a persisted 'sovits' to 'auto' instead of failing the config parse", () => {
    expect(field.parse("sovits")).toBe("auto");
  });

  it("still accepts every live engine and defaults to auto", () => {
    for (const v of ["auto", "voxcpm", "chatterbox", "lite", "xai"]) {
      expect(field.parse(v)).toBe(v);
    }
    expect(field.parse(undefined)).toBe("auto");
  });

  it("still rejects values that were never engines", () => {
    expect(() => field.parse("piper")).toThrow();
  });

  it("settings-schema validates the same value set the same way (lockstep)", () => {
    const validate = settingsValidate();
    for (const v of ["auto", "voxcpm", "chatterbox", "lite", "xai", "sovits"]) {
      expect(validate.parse(v)).toBe(field.parse(v));
    }
    expect(() => validate.parse("piper")).toThrow();
  });
});

describe("voice tier registry after sovits removal", () => {
  it("has no studio-trained tier and no sovits paths", () => {
    expect(tierById("studio-trained")).toBeUndefined();
    for (const t of TIERS) {
      expect(t.venvDir.toLowerCase()).not.toContain("sovits");
      expect(t.installerPath.toLowerCase()).not.toContain("sovits");
    }
  });

  it("keeps the live tiers intact (VoxCPM primary + Chatterbox backup)", () => {
    expect(TIERS.map(t => t.id)).toEqual(["lite", "studio", "studio-vox", "native"]);
  });

  it("maps every /voice command tier onto a real, startable sidecar tier", () => {
    for (const [alias, id] of Object.entries(VOICE_COMMAND_TIER_MAP)) {
      const tier = tierById(id);
      expect(tier, `/voice ${alias} points at unknown tier id '${id}'`).toBeDefined();
      expect(tier!.kind ?? "sidecar").toBe("sidecar");
    }
  });
});
