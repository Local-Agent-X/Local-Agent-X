/**
 * The gate's OWN classification of a failed browser launch.
 *
 * app-build-smoke-gate.test.ts stubs the gate runner, so it proves the
 * adapter's routing but says nothing about where `skipKind` comes from. This
 * file drives the REAL runAppSmokeGate with a launch that throws, and pins the
 * seam that decides which skip it was: the shared browser probe
 * (src/browser-availability.ts — the same probe doctor.ts renders), not a
 * second copy of that knowledge inside the build path.
 *
 * Both the smoke primitive and the probe are mocked because the verdict under
 * test must not depend on whether THIS machine happens to have chromium.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserAvailability } from "../src/browser-availability.js";

let availability: BrowserAvailability = { available: true };

vi.mock("../src/auto-build/scenario-scorer/smoke.js", () => ({
  smokeUrl: async () => { throw new Error("browserType.launch: Executable doesn't exist"); },
}));
vi.mock("../src/browser-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/browser-availability.js")>()),
  probeBrowserAvailability: () => availability,
}));

const { runAppSmokeGate } = await import("../src/canonical-loop/adapters/app-build-smoke-gate.js");
const { BROWSER_INSTALL_FIX } = await import("../src/browser-availability.js");

const dirs: string[] = [];
function staticAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-nobrowser-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body><div id='root'>hi</div></body></html>");
  return dir;
}
beforeEach(() => { availability = { available: true }; });
afterEach(() => {
  while (dirs.length > 0) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

describe("runAppSmokeGate — why the smoke was skipped", () => {
  it("probe says no browser → the skip is classified and carries the SHARED fix command", async () => {
    availability = { available: false, reason: "playwright-missing", message: "Playwright is not installed" };
    const outcome = await runAppSmokeGate({ appDir: staticAppDir(), mode: "strict" });
    expect(outcome.verdict).toBe("skipped");
    expect(outcome.skipKind).toBe("no-browser");
    expect(outcome.detail).toContain("Playwright is not installed");
    expect(outcome.detail).toContain(BROWSER_INSTALL_FIX);
  });

  // The corrupt/partial-install case: the executable path exists so the probe
  // says "available", and the launch throws anyway. It is still a browser that
  // never opened — classified (so the verify adapter writes its durable note)
  // but under its OWN kind, because the remedy is a reinstall, not an install.
  it("probe says a browser IS available → the launch failure is classified as browser-launch-failed [regression]", async () => {
    availability = { available: true };
    const outcome = await runAppSmokeGate({ appDir: staticAppDir(), mode: "strict" });
    expect(outcome.verdict).toBe("skipped");
    expect(outcome.skipKind).toBe("browser-launch-failed");
    expect(outcome.detail).toContain("Playwright reports its chromium binary is present");
  });

  // The launch error is EVIDENCE — it is the only thing that distinguishes a
  // corrupt binary from a genuinely absent one, and the only thing that can
  // contradict a wrong remedy. It used to be dropped entirely on the
  // probe-says-unavailable branch, where every failure was retold as "no
  // headless browser" in the probe's words alone.
  it("BOTH branches keep the real launch error, never just the probe's verdict [regression]", async () => {
    availability = { available: false, reason: "chromium-not-downloaded", message: "chromium was never downloaded" };
    const missing = await runAppSmokeGate({ appDir: staticAppDir(), mode: "strict" });
    expect(missing.detail).toContain("Executable doesn't exist");
    availability = { available: true };
    const corrupt = await runAppSmokeGate({ appDir: staticAppDir(), mode: "strict" });
    expect(corrupt.detail).toContain("Executable doesn't exist");
  });
});
