import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join, dirname } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isInstalled, sitePackagesDir } from "./detection.js";
import { IS_WIN, PYTHON_EXE, type VoiceTier } from "./tiers.js";

// Regression lock for the "Installed, not running" lie.
//
// `python -m venv` creates the interpreter BEFORE pip installs anything, so a
// venv whose `pip install` failed is left on disk holding nothing but pip.
// isInstalled() used to check only for the interpreter, so the picker showed
// that corpse as "Installed", enabled Start, and the user got a
// ModuleNotFoundError crash instead of the install error that explained it.
// The install failure and the crash were two hours apart in the logs.

const tier = (venvDir: string, installMarkers?: string[]): VoiceTier => ({
  id: "test-tier",
  label: "Test tier",
  port: 9999,
  venvDir,
  installerPath: "",
  startCmd: () => ({ command: "", args: [] }),
  healthUrl: "",
  description: "",
  diskFootprint: "",
  ...(installMarkers ? { installMarkers } : {}),
});

/** Build a venv skeleton: interpreter always, plus whatever packages named. */
function makeVenv(root: string, packages: string[], opts: { sitePackages?: boolean } = {}): string {
  const venvDir = join(root, "venv");
  const py = join(venvDir, PYTHON_EXE);
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(py, "");
  if (opts.sitePackages === false) return venvDir;
  const sp = IS_WIN
    ? join(venvDir, "Lib", "site-packages")
    : join(venvDir, "lib", "python3.12", "site-packages");
  mkdirSync(sp, { recursive: true });
  for (const p of packages) mkdirSync(join(sp, p), { recursive: true });
  return venvDir;
}

describe("isInstalled", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "voice-detect-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reports a venv holding ONLY pip as NOT installed (the failed-install corpse)", () => {
    const venvDir = makeVenv(join(root, "pip-only"), ["pip", "pip-26.1.2.dist-info"]);
    expect(isInstalled(tier(venvDir, ["numpy", "faster_whisper", "kokoro_onnx"]))).toBe(false);
  });

  it("reports a venv with every marker present as installed", () => {
    const venvDir = makeVenv(join(root, "complete"), ["pip", "numpy", "faster_whisper", "kokoro_onnx"]);
    expect(isInstalled(tier(venvDir, ["numpy", "faster_whisper", "kokoro_onnx"]))).toBe(true);
  });

  it("reports NOT installed when even one marker is missing (pip rolls back the whole batch)", () => {
    const venvDir = makeVenv(join(root, "partial"), ["pip", "numpy", "faster_whisper"]);
    expect(isInstalled(tier(venvDir, ["numpy", "faster_whisper", "kokoro_onnx"]))).toBe(false);
  });

  it("reports NOT installed when the interpreter itself is absent", () => {
    expect(isInstalled(tier(join(root, "nonexistent", "venv"), ["numpy"]))).toBe(false);
  });

  it("accepts a single-file module as a marker", () => {
    const venvDir = makeVenv(join(root, "single-file"), ["pip"]);
    const sp = sitePackagesDir(venvDir);
    writeFileSync(join(sp!, "somemod.py"), "");
    expect(isInstalled(tier(venvDir, ["somemod"]))).toBe(true);
  });

  // Conservative fallbacks: never report a real install as broken.
  it("falls back to the interpreter check for a tier that declares no markers", () => {
    const venvDir = makeVenv(join(root, "no-markers"), ["pip"]);
    expect(isInstalled(tier(venvDir))).toBe(true);
  });

  it("falls back to the interpreter check when site-packages can't be located", () => {
    const venvDir = makeVenv(join(root, "no-sitepkgs"), [], { sitePackages: false });
    expect(isInstalled(tier(venvDir, ["numpy"]))).toBe(true);
  });
});

describe("sitePackagesDir", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "voice-sp-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("locates site-packages in this platform's venv layout", () => {
    const venvDir = makeVenv(join(root, "v"), ["numpy"]);
    const sp = sitePackagesDir(venvDir);
    expect(sp).not.toBeNull();
    expect(sp).toContain("site-packages");
  });

  it("returns null for a venv that has no site-packages at all", () => {
    const venvDir = makeVenv(join(root, "empty"), [], { sitePackages: false });
    expect(sitePackagesDir(venvDir)).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(sitePackagesDir("")).toBeNull();
  });
});
