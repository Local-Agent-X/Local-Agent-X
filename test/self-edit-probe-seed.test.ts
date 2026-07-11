/**
 * Tests for probe-provider seeding (seedProbeProvider in
 * self-edit/sandbox-gates.ts).
 *
 * The gated path's bind probe boots LAX on a FRESH data dir; without seeding it
 * seedProbeProvider writes settings.json {provider} and returns the canonical
 * credential path for the child environment without copying credential bytes
 * into the fresh data dir.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_DIR = mkdtempSync(join(tmpdir(), "lax-seed-real-"));
process.env.LAX_DATA_DIR = REAL_DIR;

const { seedProbeProvider } = await import("../src/self-edit/sandbox-gates.js");

let probeDir: string;
beforeEach(() => {
  probeDir = mkdtempSync(join(tmpdir(), "lax-seed-probe-"));
  // Reset the simulated "real" data dir's token files between tests.
  for (const f of ["xai-auth.json", "anthropic-auth.json", "auth.json"]) {
    try { rmSync(join(REAL_DIR, f), { force: true }); } catch { /* ignore */ }
  }
});

describe("seedProbeProvider", () => {
  it("writes settings.json with the active provider", () => {
    seedProbeProvider(probeDir, "xai");
    const settings = JSON.parse(readFileSync(join(probeDir, "settings.json"), "utf-8"));
    expect(settings.provider).toBe("xai");
  });

  it("returns the canonical active-provider path without copying it", () => {
    writeFileSync(join(REAL_DIR, "xai-auth.json"), '{"access_token":"xai-tok"}');
    const result = seedProbeProvider(probeDir, "xai");
    expect(result.credentialPath).toBe(join(REAL_DIR, "xai-auth.json"));
    expect(existsSync(join(probeDir, "xai-auth.json"))).toBe(false);
  });

  it("does not copy any provider credential into the fresh data dir", () => {
    writeFileSync(join(REAL_DIR, "xai-auth.json"), "xai");
    writeFileSync(join(REAL_DIR, "anthropic-auth.json"), "ant");
    seedProbeProvider(probeDir, "xai");
    expect(existsSync(join(probeDir, "xai-auth.json"))).toBe(false);
    expect(existsSync(join(probeDir, "anthropic-auth.json"))).toBe(false);
  });

  it("maps codex/openai to auth.json", () => {
    writeFileSync(join(REAL_DIR, "auth.json"), "openai-oauth");
    const result = seedProbeProvider(probeDir, "codex");
    expect(result.credentialPath).toBe(join(REAL_DIR, "auth.json"));
    expect(existsSync(join(probeDir, "auth.json"))).toBe(false);
  });

  it("still writes settings.json when no token file exists (env/secrets-store creds)", () => {
    seedProbeProvider(probeDir, "gemini");
    expect(existsSync(join(probeDir, "settings.json"))).toBe(true);
    // gemini has no mapped token file.
    expect(existsSync(join(probeDir, "auth.json"))).toBe(false);
  });

  it("returns a precise unavailable status when canonical auth is absent", () => {
    expect(seedProbeProvider(probeDir, "xai")).toEqual({
      unavailable: "canonical xai-auth.json is unavailable; probe requires an environment credential",
    });
  });
});
