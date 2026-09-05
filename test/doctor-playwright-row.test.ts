/**
 * Doctor's Playwright row must state something TRUE about this machine.
 *
 * The probe answers one question — "can Playwright's BUNDLED chromium launch".
 * Doctor used to render that as "browser tools disabled", which is a different
 * question and is FALSE on the most common box: src/browser/launcher.ts spawns
 * system Chrome and connectOverCDP first, and its first Playwright fallback is
 * launchPersistentContext({ channel: "chrome" }) — system Chrome again. The
 * bundled binary is only the third fallback. So with Chrome installed and
 * `playwright install chromium` never run, every browser tool works and doctor
 * claimed they were disabled.
 *
 * The row is rendered from a pure function so the claim can be pinned on any
 * machine — the live probe's answer here is one fixed value, which is exactly
 * how the false claim went unnoticed.
 */
import { describe, it, expect } from "vitest";
import { playwrightDiagnostic } from "../src/doctor.js";
import { BROWSER_INSTALL_FIX } from "../src/browser-availability.js";

describe("doctor — the Playwright row", () => {
  it("no package at all → browser tools really ARE disabled", () => {
    const row = playwrightDiagnostic({
      available: false, reason: "playwright-missing", message: "Playwright is not installed",
    });
    expect(row.status).toBe("warn");
    expect(row.message).toContain("browser tools disabled");
    expect(row.fix).toBe(BROWSER_INSTALL_FIX);
  });

  // The mutation pin: say "browser tools disabled" here and this fails.
  it("package present, bundled chromium missing → smoke gate down, browser tools NOT disabled [regression]", () => {
    const row = playwrightDiagnostic({
      available: false,
      reason: "chromium-not-downloaded",
      message: "Playwright is installed, but its bundled chromium was never downloaded",
    });
    expect(row.status).toBe("warn");
    expect(row.message).toContain("app_build smoke gate");
    expect(row.message).toContain("fall back to system Chrome");
    // The false claim, verbatim, must not be what this box is told.
    expect(row.message).not.toMatch(/browser tools disabled/);
    expect(row.fix).toBe(BROWSER_INSTALL_FIX);
  });

  it("a launchable bundled chromium → pass", () => {
    expect(playwrightDiagnostic({ available: true })).toMatchObject({ status: "pass", message: "Installed" });
  });
});
