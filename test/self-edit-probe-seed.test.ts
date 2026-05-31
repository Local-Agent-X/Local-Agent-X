/**
 * Tests for probe-provider seeding (seedProbeProvider in
 * self-edit-sandbox-gates.ts).
 *
 * The gated path's bind probe boots LAX on a FRESH data dir; without seeding it
 * defaults to anthropic with no credential, so the smoke gate's /api/chat can't
 * get a completion for a codex/xai/subscription user. seedProbeProvider writes
 * settings.json {provider} and copies THAT provider's token file (only) into the
 * probe dir. LAX_DATA_DIR points at a temp "real" dir so the source token is
 * controllable and no developer creds are touched.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_DIR = mkdtempSync(join(tmpdir(), "lax-seed-real-"));
process.env.LAX_DATA_DIR = REAL_DIR;

const { seedProbeProvider } = await import("../src/self-edit-sandbox-gates.js");

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

  it("copies the active provider's token file into the probe dir", () => {
    writeFileSync(join(REAL_DIR, "xai-auth.json"), '{"access_token":"xai-tok"}');
    seedProbeProvider(probeDir, "xai");
    expect(existsSync(join(probeDir, "xai-auth.json"))).toBe(true);
    expect(readFileSync(join(probeDir, "xai-auth.json"), "utf-8")).toContain("xai-tok");
  });

  it("copies ONLY the active provider's token, not other providers'", () => {
    writeFileSync(join(REAL_DIR, "xai-auth.json"), "xai");
    writeFileSync(join(REAL_DIR, "anthropic-auth.json"), "ant");
    seedProbeProvider(probeDir, "xai");
    expect(existsSync(join(probeDir, "xai-auth.json"))).toBe(true);
    expect(existsSync(join(probeDir, "anthropic-auth.json"))).toBe(false);
  });

  it("maps codex/openai to auth.json", () => {
    writeFileSync(join(REAL_DIR, "auth.json"), "openai-oauth");
    seedProbeProvider(probeDir, "codex");
    expect(existsSync(join(probeDir, "auth.json"))).toBe(true);
  });

  it("still writes settings.json when no token file exists (env/secrets-store creds)", () => {
    seedProbeProvider(probeDir, "gemini");
    expect(existsSync(join(probeDir, "settings.json"))).toBe(true);
    // gemini has no mapped token file — nothing to copy, and that's fine.
    expect(existsSync(join(probeDir, "auth.json"))).toBe(false);
  });
});
