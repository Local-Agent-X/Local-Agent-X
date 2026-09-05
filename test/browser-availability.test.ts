/**
 * The browser probe's OWN logic — the piece that had zero coverage.
 *
 * Both gate tests mock `../src/browser-availability.js` wholesale, so they pin
 * how CALLERS route on its answer and say nothing about how the answer is
 * reached. Deleting the `existsSync(path)` check — gutting the entire second
 * failure mode the module exists for (installed package, browser binary never
 * downloaded) — left every one of those tests green.
 *
 * So: this file imports the module UNMOCKED and drives the real function. Only
 * the two host lookups are injected (resolve a module id / load playwright),
 * because a test that depended on whether THIS machine has chromium would
 * assert nothing. The on-disk check is deliberately NOT injected in the two
 * cases below that turn on it — it runs the real `existsSync` against a real
 * temp file and a real absent path, so removing it flips those assertions.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_INSTALL_FIX,
  probeBrowserAvailability,
  type BrowserProbeDeps,
} from "../src/browser-availability.js";

const dirs: string[] = [];
/** A path that really exists on this filesystem, standing in for a downloaded
 *  chromium executable. */
function realFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-probe-"));
  dirs.push(dir);
  const file = join(dir, "headless_shell");
  writeFileSync(file, "not really a browser, but it is really a file");
  return file;
}
/** A path under a real directory that does NOT exist — the interrupted-install
 *  shape: Playwright knows where the binary goes, nothing was ever put there. */
function absentPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-probe-"));
  dirs.push(dir);
  return join(dir, "chrome-linux", "chrome");
}
afterEach(() => {
  while (dirs.length > 0) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

/** Playwright is installed and points chromium at `path`. `fileExists` is left
 *  to the real implementation on purpose — see the file header. */
function installedPointingAt(path: string): BrowserProbeDeps {
  return {
    resolveModule: (id) => `/node_modules/${id}/index.js`,
    loadPlaywright: () => ({ chromium: { executablePath: () => path } }),
  };
}

describe("probeBrowserAvailability", () => {
  it("package not resolvable → playwright-missing", () => {
    const probe = probeBrowserAvailability({
      resolveModule: () => { throw new Error("Cannot find module 'playwright'"); },
      loadPlaywright: () => { throw new Error("should never be reached"); },
    });
    expect(probe).toEqual({
      available: false,
      reason: "playwright-missing",
      message: "Playwright is not installed",
    });
  });

  it("executable exists on disk → available", () => {
    expect(probeBrowserAvailability(installedPointingAt(realFile()))).toEqual({ available: true });
  });

  // THE mutation pin. Delete `&& fileExists(path)` from the probe and this
  // returns { available: true } — the interrupted-`playwright install` box
  // reports a healthy browser, doctor shows a pass, and the app-build smoke
  // gate's skip goes back to being explained as something it isn't.
  it("executable path is known but NOT on disk → chromium-not-downloaded [mutation pin]", () => {
    const probe = probeBrowserAvailability(installedPointingAt(absentPath()));
    expect(probe.available).toBe(false);
    expect(probe).toMatchObject({ reason: "chromium-not-downloaded" });
  });

  it("Playwright reports no executable path at all → chromium-not-downloaded", () => {
    const probe = probeBrowserAvailability(installedPointingAt(""));
    expect(probe).toMatchObject({ available: false, reason: "chromium-not-downloaded" });
  });

  // executablePath() throws when Playwright's registry has no chromium entry —
  // the user-visible situation is identical to a path that isn't on disk, and
  // the probe must not let that throw escape into a caller's happy path.
  it("loading playwright throws → chromium-not-downloaded, never a thrown error", () => {
    const probe = probeBrowserAvailability({
      resolveModule: (id) => `/node_modules/${id}/index.js`,
      loadPlaywright: () => { throw new Error("Executable doesn't exist / registry has no chromium"); },
    });
    expect(probe).toMatchObject({ available: false, reason: "chromium-not-downloaded" });
  });

  it("executablePath() itself throws → chromium-not-downloaded, never a thrown error", () => {
    const probe = probeBrowserAvailability({
      resolveModule: (id) => `/node_modules/${id}/index.js`,
      loadPlaywright: () => ({ chromium: { executablePath: () => { throw new Error("no chromium entry"); } } }),
    });
    expect(probe).toMatchObject({ available: false, reason: "chromium-not-downloaded" });
  });

  // No injection at all: the defaults (require.resolve / require / existsSync)
  // must produce a well-formed verdict on whatever machine this runs on, and
  // must not throw. Which verdict is machine-dependent, so it isn't asserted.
  it("with no injected deps it answers about the real machine without throwing", () => {
    const probe = probeBrowserAvailability();
    expect(typeof probe.available).toBe("boolean");
    if (!probe.available) {
      expect(["playwright-missing", "chromium-not-downloaded"]).toContain(probe.reason);
      expect(probe.message.length).toBeGreaterThan(0);
    }
  });

  it("the install command has exactly one definition, and it is the whole remedy", () => {
    expect(BROWSER_INSTALL_FIX).toBe("npm install playwright && npx playwright install chromium");
  });
});
