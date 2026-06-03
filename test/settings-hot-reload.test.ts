/**
 * Integration test for the settings hot-reload chain.
 *
 * This test pins SECURITY-CRITICAL wiring: when the user flips a permission off
 * in the UI, the change MUST take effect without a server restart. The chain:
 *
 *   1. settingTool / settings POST → saveConfig() writes config.json on disk
 *   2. The fs watcher started by startConfigWatcher() (src/server/lifecycle.ts)
 *      observes the change (500ms debounce inside ConfigWatcher)
 *   3. The onChange callback calls setRuntimeConfig(loadConfig())
 *   4. getRuntimeConfig() returns the fresh value to every gate / dispatcher
 *
 * If anyone removes `setRuntimeConfig(loadConfig())` from the onChange handler
 * (or replaces it with a no-op), THIS test must fail — that regression would
 * silently re-enable disabled tools until process restart.
 *
 * Setup notes:
 *   - getConfigPath() in src/config.ts resolves through HOME/USERPROFILE +
 *     ".lax/config.json", NOT through LAX_DATA_DIR. So we override the user's
 *     home dir to a temp path so loadConfig/saveConfig point at our fixture.
 *     We also pass `<tmp>/.lax` as the dataDir to startConfigWatcher so its
 *     `join(dataDir, "config.json")` matches getConfigPath().
 *   - Real fs.watch (no mocks). The watcher debounces at 500ms — we poll up
 *     to 4000ms (NOT a fixed sleep) for the change to land.
 *   - Test 2 (the regression-pin) uses vi.doMock + vi.resetModules + a fresh
 *     re-import of lifecycle.ts so the watcher's static import of
 *     setRuntimeConfig binds to the spy. We then trigger the same fs change
 *     and assert the spy was called with the new value.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
  getConfigPath,
  getRuntimeConfig,
  loadConfig,
  saveConfig,
  setRuntimeConfig,
} from "../src/config.js";
import { startConfigWatcher } from "../src/server/lifecycle.js";
import { ConfigWatcher } from "../src/config-hot-reload.js";

// ── env capture ──
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;

// ── temp dirs / paths populated in beforeAll ──
let tmpHome: string;
let dataDir: string;
let cfgPath: string;
let originalRuntimeConfig: ReturnType<typeof getRuntimeConfig> | null = null;
let originalRealHomeRuntime: ReturnType<typeof getRuntimeConfig> | null = null;

// ── private watcher refs we have to cleanup so an open fs.watch doesn't
//    keep the vitest process alive after the suite finishes ──
const trackedWatchers: ConfigWatcher[] = [];
const realStart = ConfigWatcher.prototype.start;
function patchConfigWatcherTracking() {
  ConfigWatcher.prototype.start = function (this: ConfigWatcher, ...args: Parameters<ConfigWatcher["start"]>) {
    trackedWatchers.push(this);
    return realStart.apply(this, args);
  };
}
function unpatchConfigWatcherTracking() {
  ConfigWatcher.prototype.start = realStart;
}

beforeAll(() => {
  // Capture the existing runtime config (if any) so we can restore it after
  // the suite. Other tests sharing the worker may rely on it.
  try { originalRealHomeRuntime = getRuntimeConfig(); } catch { /* unset */ }

  // Point loadConfig/saveConfig at a temp "home". getConfigDir() reads
  // process.env.HOME || process.env.USERPROFILE at CALL time, so flipping
  // these here is enough — no need to bust the module cache.
  tmpHome = mkdtempSync(join(tmpdir(), "lax-settings-hotreload-"));
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
  // LAX_DATA_DIR is unrelated to getConfigPath, but a sibling subsystem
  // may read it from the watcher's caller — wipe it to keep the test pure.
  delete process.env.LAX_DATA_DIR;

  dataDir = join(tmpHome, ".lax");
  mkdirSync(dataDir, { recursive: true });
  cfgPath = getConfigPath();
  // Sanity: the path we'll write to MUST match what loadConfig will read,
  // which MUST match what the watcher polls. If this assertion fails the
  // whole test is meaningless, so we fail loud now.
  expect(cfgPath).toBe(join(dataDir, "config.json"));

  // Write an initial config with a known security-critical field value.
  // We pick enableShell because that's the canonical security toggle in
  // the comment block of startConfigWatcher (lifecycle.ts:340).
  const initial = {
    port: 7007,
    authToken: "test-token-32-bytes-of-hex-padding-aaaa",
    workspace: "./workspace",
    enableShell: true,
    enableHttp: true,
    enableBrowser: true,
    model: "test-model",
  };
  writeFileSync(cfgPath, JSON.stringify(initial, null, 2), "utf-8");

  // Snapshot the runtime config we're about to mutate, so we can restore
  // the previous global value at the end of the suite.
  originalRuntimeConfig = (() => {
    try { return getRuntimeConfig(); } catch { return null; }
  })();

  patchConfigWatcherTracking();
});

afterAll(() => {
  // Stop every watcher created via startConfigWatcher in this suite so its
  // fs.watch handles don't keep node alive.
  for (const w of trackedWatchers) {
    try { w.stop(); } catch { /* best-effort */ }
  }
  unpatchConfigWatcherTracking();

  // Restore env first so subsequent restoreRuntimeConfig reads the real disk.
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;

  // Restore the runtime config to the value other tests see. If we never
  // captured one (clean module load), reset to null by reloading from the
  // real home so a follow-up getRuntimeConfig() rebuilds correctly.
  if (originalRealHomeRuntime) {
    setRuntimeConfig(originalRealHomeRuntime);
  } else if (originalRuntimeConfig) {
    setRuntimeConfig(originalRuntimeConfig);
  }

  // Remove the temp home tree.
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Poll predicate up to `timeoutMs`. Resolves true on first truthy poll,
 * false if it never went truthy. NOT a fixed sleep — returns as soon as
 * the watcher's debounced reload fires.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

describe("settings hot-reload chain", () => {
  it("saveConfig → fs watcher → setRuntimeConfig → getRuntimeConfig (happy path)", async () => {
    // (a) Seed the runtime config from disk so the watcher has a known baseline.
    setRuntimeConfig(loadConfig());
    const before = getRuntimeConfig();
    expect(before.enableShell).toBe(true);

    // (b) Start the real watcher with the real fs (no mocks).
    startConfigWatcher(dataDir);

    // (c) Write a clearly-different value via the canonical saveConfig path.
    //     This is what setting-tool.ts does after applying a runtime field.
    const mutated = { ...before, enableShell: false };
    saveConfig(mutated);

    // (d) Poll for the new value. ConfigWatcher debounces at 500ms; on Windows
    //     fs.watch can fire a single rename event for the atomic write (.tmp
    //     rename) so 4000ms gives ample headroom.
    const reloaded = await waitUntil(
      () => getRuntimeConfig().enableShell === false,
      4000,
    );

    // (e) The wire-up assertion. If this fails, hot-reload is broken — the
    //     gate would keep saying YES to shell after the user said NO.
    expect(reloaded).toBe(true);
    expect(getRuntimeConfig().enableShell).toBe(false);
  });

  it("regression-pin: watcher's onChange invokes setRuntimeConfig with the reloaded config", async () => {
    // Strategy: vi.doMock + vi.resetModules so a fresh lifecycle.ts re-imports
    // a SPIED setRuntimeConfig. Then we trigger an fs change and confirm the
    // spy was called with the new value. This pins THE WIRE, not just the
    // effect — if the onChange handler ever loses the setRuntimeConfig call,
    // the spy stays at 0 calls and the test fails.

    // First, reset the on-disk value to a known starting point so the spy's
    // call args are unambiguous.
    const baseline = { ...loadConfig(), enableShell: true };
    saveConfig(baseline);
    setRuntimeConfig(baseline);
    // Drain any in-flight watcher reload from the previous test that might
    // race this one. The previous watcher is still alive (we stop them in
    // afterAll), so a write here would fire its onChange too — that's fine,
    // it just re-applies baseline. We wait briefly for the debounce window
    // to clear before installing the spy.
    await new Promise((r) => setTimeout(r, 700));

    const spy = vi.fn((cfg: unknown) => {
      // Mirror the real behavior so the rest of the runtime stays consistent
      // for any other tests/poll loops that may read getRuntimeConfig.
      setRuntimeConfig(cfg as ReturnType<typeof loadConfig>);
    });

    vi.resetModules();
    vi.doMock("../src/config.js", async () => {
      const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
      return { ...actual, setRuntimeConfig: spy };
    });

    let watcherStopFn: (() => void) | null = null;
    try {
      const lifecycle = await import("../src/server/lifecycle.js");
      const cfgMod = await import("../src/config.js");
      const watcherMod = await import("../src/config-hot-reload.js");

      // Track the new (re-imported) ConfigWatcher's start so we can stop it.
      const FreshWatcher = watcherMod.ConfigWatcher;
      const freshRealStart = FreshWatcher.prototype.start;
      const created: InstanceType<typeof FreshWatcher>[] = [];
      FreshWatcher.prototype.start = function (this: InstanceType<typeof FreshWatcher>, ...args: Parameters<typeof freshRealStart>) {
        created.push(this);
        return freshRealStart.apply(this, args);
      };

      lifecycle.startConfigWatcher(dataDir);

      // Restore the prototype hook immediately so we don't leak it.
      FreshWatcher.prototype.start = freshRealStart;
      watcherStopFn = () => { for (const w of created) { try { w.stop(); } catch { /* best-effort */ } } };

      // Now write a NEW distinguishable value through the (mocked-import-graph)
      // saveConfig. We use the actual saveConfig from the original module
      // — the spy wraps setRuntimeConfig only.
      const distinguishable = { ...baseline, enableShell: false };
      cfgMod.saveConfig(distinguishable);

      // Poll for spy invocation. 4000ms covers the 500ms debounce + Windows
      // fs.watch quirks.
      const fired = await waitUntil(() => spy.mock.calls.length > 0, 4000);
      expect(fired).toBe(true);

      // The most recent spy call MUST carry a config whose enableShell is the
      // value we just wrote — that's the proof the watcher loaded fresh from
      // disk before calling setRuntimeConfig, not just passed a stale ref.
      const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
      expect(lastCall).toBeDefined();
      const cfgArg = lastCall![0] as { enableShell?: boolean };
      expect(cfgArg).toBeTypeOf("object");
      expect(cfgArg.enableShell).toBe(false);
    } finally {
      if (watcherStopFn) watcherStopFn();
      vi.doUnmock("../src/config.js");
      vi.resetModules();
    }
  });
});
