import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAppearanceDefaultGeneration,
  APPEARANCE_DEFAULT_GEN,
  loadSettings,
  reloadSettings,
  setSetting,
  settingsPath,
} from "./settings.js";

// One-time appearance default rollout (gen 2: dark + aurora; gen 1 was
// dark + phosphor). The contract under test: the generation marker — not the
// theme/palette values — gates the migration, so it fires exactly once per
// install and never clobbers a choice the user makes afterwards.

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-appearance-"));
  process.env.LAX_DATA_DIR = dir;
  reloadSettings();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
  reloadSettings();
});

describe("applyAppearanceDefaultGeneration", () => {
  it("gives a fresh install dark + aurora and stamps the generation", () => {
    expect(applyAppearanceDefaultGeneration()).toBe(true);
    const settings = loadSettings();
    expect(settings.theme).toBe("dark");
    expect(settings.palette).toBe("aurora");
    expect(settings.appearanceDefaultGen).toBe(APPEARANCE_DEFAULT_GEN);
    // Persisted, not just cached.
    const onDisk = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    expect(onDisk.palette).toBe("aurora");
  });

  it("switches an existing install's prior choice exactly once", () => {
    writeFileSync(settingsPath(), JSON.stringify({ theme: "light", palette: "bloom", sidebarPins: ["chat"] }));
    reloadSettings();
    expect(applyAppearanceDefaultGeneration()).toBe(true);
    const settings = loadSettings();
    expect(settings.theme).toBe("dark");
    expect(settings.palette).toBe("aurora");
    // Sibling keys survive the migration write.
    expect(settings.sidebarPins).toEqual(["chat"]);
  });

  it("re-applies when an install is on a PRIOR generation (gen-1 phosphor → gen-2 aurora)", () => {
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark", palette: "phosphor", appearanceDefaultGen: 1 }));
    reloadSettings();
    expect(applyAppearanceDefaultGeneration()).toBe(true);
    const settings = loadSettings();
    expect(settings.palette).toBe("aurora");
    expect(settings.appearanceDefaultGen).toBe(APPEARANCE_DEFAULT_GEN);
  });

  it("never overrides a choice the user makes after the rollout", () => {
    applyAppearanceDefaultGeneration();
    setSetting("palette", "nebula");
    setSetting("theme", "light");
    expect(applyAppearanceDefaultGeneration()).toBe(false);
    const settings = loadSettings();
    expect(settings.palette).toBe("nebula");
    expect(settings.theme).toBe("light");
  });

  it("skips installs already at or past the current generation", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ theme: "light", palette: "cobalt", appearanceDefaultGen: APPEARANCE_DEFAULT_GEN }),
    );
    reloadSettings();
    expect(applyAppearanceDefaultGeneration()).toBe(false);
    expect(loadSettings().palette).toBe("cobalt");
  });
});
