/**
 * Settings-override wiring for the fresh-install calibration model.
 *
 * Verifies that `~/.lax/settings.json` values under the `threat` key are
 * picked up by the next ThreatEngine session, so operators can tune
 * threat.startingBudget / threat.decayPerHour / threat.decayPerTurn
 * without code changes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreatEngine, _invalidateThreatSettingsCacheForTests } from "../src/threat/threat-engine.js";

let prevHome: string | undefined;
let prevUserprofile: string | undefined;
let fakeHome: string;
let dataDir: string;

function writeSettings(threat: Record<string, unknown>): void {
  const laxDir = join(fakeHome, ".lax");
  mkdirSync(laxDir, { recursive: true });
  writeFileSync(join(laxDir, "settings.json"), JSON.stringify({ threat }), "utf-8");
  _invalidateThreatSettingsCacheForTests();
}

beforeEach(() => {
  prevHome = process.env.HOME;
  prevUserprofile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(join(tmpdir(), "lax-threat-settings-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  dataDir = mkdtempSync(join(tmpdir(), "lax-threat-data-"));
  _invalidateThreatSettingsCacheForTests();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserprofile;
  _invalidateThreatSettingsCacheForTests();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("ThreatEngine — settings.json override", () => {
  it("uses defaults when no settings file exists", () => {
    const eng = new ThreatEngine(dataDir, "sess-defaults");
    expect(eng.scorer.startingBudget).toBe(60);
    expect(eng.scorer.decayPerHour).toBe(5);
    expect(eng.scorer.decayPerTurn).toBe(1);
  });

  it("honors threat.startingBudget override", () => {
    writeSettings({ startingBudget: 120 });
    const eng = new ThreatEngine(dataDir, "sess-budget");
    expect(eng.scorer.startingBudget).toBe(120);
  });

  it("honors threat.decayPerHour override", () => {
    writeSettings({ decayPerHour: 25 });
    const eng = new ThreatEngine(dataDir, "sess-decay-hour");
    expect(eng.scorer.decayPerHour).toBe(25);
  });

  it("honors threat.decayPerTurn override", () => {
    writeSettings({ decayPerTurn: 4 });
    const eng = new ThreatEngine(dataDir, "sess-decay-turn");
    expect(eng.scorer.decayPerTurn).toBe(4);
  });

  it("falls back to defaults on malformed settings without throwing", () => {
    const laxDir = join(fakeHome, ".lax");
    mkdirSync(laxDir, { recursive: true });
    writeFileSync(join(laxDir, "settings.json"), "{ not json", "utf-8");
    _invalidateThreatSettingsCacheForTests();
    const eng = new ThreatEngine(dataDir, "sess-bad");
    expect(eng.scorer.startingBudget).toBe(60);
  });

  it("rejects negative override values (treats as missing)", () => {
    writeSettings({ startingBudget: -10, decayPerHour: -1 });
    const eng = new ThreatEngine(dataDir, "sess-negative");
    expect(eng.scorer.startingBudget).toBe(60);
    expect(eng.scorer.decayPerHour).toBe(5);
  });

  it("setting threat.startingBudget=0 reproduces pre-calibration gate behavior", () => {
    writeSettings({ startingBudget: 0, decayPerHour: 0, decayPerTurn: 0 });
    const eng = new ThreatEngine(dataDir, "sess-strict");
    eng.scorer.record("credential_in_output", 60, "x");
    expect(eng.scorer.isRestricted()).toBe(true);
  });
});
