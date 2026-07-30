import { afterEach, describe, expect, it, vi } from "vitest";
import { bustUpdateCache, checkForUpdate, compareDottedVersions } from "./update-service.js";

const electronEnv = "LAX_DESKTOP_ELECTRON_VERSION";
const chromiumEnv = "LAX_DESKTOP_CHROMIUM_VERSION";

afterEach(() => {
  delete process.env[electronEnv];
  delete process.env[chromiumEnv];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  bustUpdateCache();
});

describe("compareDottedVersions", () => {
  it("compares numeric components instead of lexicographic strings", () => {
    expect(compareDottedVersions("9.10.0", "10.2.0")).toBe(-1);
    expect(compareDottedVersions("43.2", "43.2.0")).toBe(0);
    expect(compareDottedVersions("44.0.0", "43.12.9")).toBe(1);
  });
});

describe("native runtime update check", () => {
  it("does not fetch or require a native update outside the desktop shell", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkForUpdate(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.nativeUpdateRequired).toBeUndefined();
    expect(result.installedElectronVersion).toBeUndefined();
  });

  it("reports an older installed Electron runtime separately from source updates", async () => {
    process.env[electronEnv] = "35.7.5";
    process.env[chromiumEnv] = "134.0.6998.205";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      electronVersion: "43.2.0",
      chromiumVersion: "150.0.0.0",
    }), { status: 200 })));

    const result = await checkForUpdate(true);

    expect(result.installedElectronVersion).toBe("35.7.5");
    expect(result.installedChromiumVersion).toBe("134.0.6998.205");
    expect(result.requiredElectronVersion).toBe("43.2.0");
    expect(result.requiredChromiumVersion).toBe("150.0.0.0");
    expect(result.nativeUpdateRequired).toBe(true);
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(result.nativeInstallerUrl).toMatch(/releases\/download\/rolling\/Install\.Local\.Agent\.X\./);
    } else {
      expect(result.nativeInstallerUrl).toBeUndefined();
    }
    expect(typeof result.updateAvailable).toBe("boolean");
  });

  it("keeps the source result when the runtime manifest is invalid", async () => {
    process.env[electronEnv] = "43.2.0";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      electronVersion: "not-a-version",
      chromiumVersion: "150.0.0.0",
    }), { status: 200 })));

    const result = await checkForUpdate(true);

    expect(typeof result.updateAvailable).toBe("boolean");
    expect(result.nativeUpdateRequired).toBeUndefined();
    expect(result.nativeRuntimeCheckError).toMatch(/invalid shape/);
    expect(result.error ?? "").not.toContain("runtime manifest");
  });
});
