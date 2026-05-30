/**
 * Tests for ConfigWatcher.start resilience.
 *
 * The watcher is a hot-reload convenience and must NEVER throw out of start() —
 * it's called during server boot (startConfigWatcher), before server.listen,
 * with no surrounding catch. A throw there aborts the whole boot. That's what
 * silently bricked the self_edit bind/smoke gates: the probe boots on a fresh
 * data dir with no config.json, the watcher threw "Config file not found", and
 * the server never bound. start() now warns and skips instead.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigWatcher } from "../src/config-hot-reload.js";

let watcher: ConfigWatcher | null = null;
afterEach(() => { watcher?.stop(); watcher = null; });

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-cfgwatch-"));
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe("ConfigWatcher.start", () => {
  it("does not throw and does not run when the file is missing", () => {
    watcher = new ConfigWatcher();
    const missing = join(mkdtempSync(join(tmpdir(), "lax-cfgwatch-")), "config.json");
    expect(() => watcher!.start(missing, () => {})).not.toThrow();
    expect(watcher.isRunning()).toBe(false);
  });

  it("does not throw and does not run on invalid JSON", () => {
    watcher = new ConfigWatcher();
    const bad = tmpFile("config.json", "{ not valid json");
    expect(() => watcher!.start(bad, () => {})).not.toThrow();
    expect(watcher.isRunning()).toBe(false);
  });

  it("does not throw and does not run when the file is a JSON array (not an object)", () => {
    watcher = new ConfigWatcher();
    const arr = tmpFile("config.json", "[1,2,3]");
    expect(() => watcher!.start(arr, () => {})).not.toThrow();
    expect(watcher.isRunning()).toBe(false);
  });

  it("runs and loads config when the file is a valid JSON object", () => {
    watcher = new ConfigWatcher();
    const good = tmpFile("config.json", JSON.stringify({ port: 7007, model: "x" }));
    watcher.start(good, () => {});
    expect(watcher.isRunning()).toBe(true);
    expect(watcher.getCurrentConfig()).toMatchObject({ port: 7007, model: "x" });
  });
});
