// Behavioral contract for initConfig(): the manifest write and both
// hot-reload watchers run when — and only when — initConfig() is called,
// and a second call is a guarded no-op (multiple entrypoints may init).
// Deps are mocked so no real fs.watch handles or manifest scans happen;
// the filesystem-level import-purity proof lives in
// config-import-purity.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const writeManifest = vi.fn();
const startManifestWatcher = vi.fn();
const startConfigWatcher = vi.fn();

vi.mock("./manifest-generator/index.js", () => ({
  writeManifest,
  startManifestWatcher,
}));

// config.ts imports startConfigWatcher; config-schema.ts (in the same import
// graph) imports loadSystemPrompt — the mock must satisfy both.
vi.mock("./config-loader.js", () => ({
  startConfigWatcher,
  loadSystemPrompt: () => "",
}));

describe("initConfig()", () => {
  const previousQualificationBoot = process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT;

  beforeEach(() => {
    delete process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT;
    vi.resetModules();
    writeManifest.mockClear();
    startManifestWatcher.mockClear();
    startConfigWatcher.mockClear();
  });

  afterEach(() => {
    if (previousQualificationBoot === undefined) delete process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT;
    else process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT = previousQualificationBoot;
  });

  it("does nothing at import time, everything on first call, nothing on the second", async () => {
    const { initConfig } = await import("./config.js");

    // Pure import: none of the old top-level side effects fired.
    expect(writeManifest).not.toHaveBeenCalled();
    expect(startConfigWatcher).not.toHaveBeenCalled();
    expect(startManifestWatcher).not.toHaveBeenCalled();

    initConfig();

    expect(writeManifest).toHaveBeenCalledTimes(1);
    expect(startConfigWatcher).toHaveBeenCalledTimes(1);
    expect(startManifestWatcher).toHaveBeenCalledTimes(1);

    // Idempotent: a second call (another entrypoint, double boot wiring)
    // must not rewrite the manifest or stack a second watcher set.
    expect(() => initConfig()).not.toThrow();

    expect(writeManifest).toHaveBeenCalledTimes(1);
    expect(startConfigWatcher).toHaveBeenCalledTimes(1);
    expect(startManifestWatcher).toHaveBeenCalledTimes(1);
  });

  it("suppresses manifest generation and repository watchers only in qualification boot", async () => {
    process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT = "1";
    const { initConfig } = await import("./config.js");

    initConfig();

    expect(writeManifest).not.toHaveBeenCalled();
    expect(startConfigWatcher).not.toHaveBeenCalled();
    expect(startManifestWatcher).not.toHaveBeenCalled();
  });
});
