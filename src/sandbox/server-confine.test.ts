import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isServerConfined,
  maybeReexecServerConfined,
  markServerSandboxHealthy,
  readBootMarker,
  serverSandboxSetting,
  writeBootMarker,
} from "./server-confine.js";

// Every test runs against a throwaway LAX_DATA_DIR so the real ~/.lax marker
// and config are never touched, and with the env knobs saved/restored.
let dataDir: string;
const SAVED = ["LAX_DATA_DIR", "LAX_SERVER_SANDBOX", "LAX_SERVER_CONFINED", "LAX_SELF_EDIT_PROBE"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  dataDir = mkdtempSync(join(tmpdir(), "lax-srvconf-"));
  process.env.LAX_DATA_DIR = dataDir;
  delete process.env.LAX_SERVER_SANDBOX;
  delete process.env.LAX_SERVER_CONFINED;
  delete process.env.LAX_SELF_EDIT_PROBE;
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("serverSandboxSetting", () => {
  it("defaults to disabled with no env and no config", () => {
    expect(serverSandboxSetting()).toEqual({ enabled: false, explicit: false });
  });

  it("env opt-in wins and is explicit", () => {
    process.env.LAX_SERVER_SANDBOX = "1";
    expect(serverSandboxSetting()).toEqual({ enabled: true, explicit: true });
  });

  it("env opt-out overrides an enabled config", () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ serverSandbox: true }));
    process.env.LAX_SERVER_SANDBOX = "off";
    expect(serverSandboxSetting()).toEqual({ enabled: false, explicit: true });
  });

  it("reads serverSandbox from config.json", () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ serverSandbox: true }));
    expect(serverSandboxSetting()).toEqual({ enabled: true, explicit: false });
  });

  it("treats a malformed config as disabled (never bricks boot)", () => {
    writeFileSync(join(dataDir, "config.json"), "{not json");
    expect(serverSandboxSetting()).toEqual({ enabled: false, explicit: false });
  });
});

describe("boot marker state machine", () => {
  it("round-trips and rejects garbage", () => {
    expect(readBootMarker()).toBeNull();
    writeBootMarker({ state: "attempting", failures: 1, updatedAt: "2026-06-10T00:00:00Z" });
    expect(readBootMarker()).toEqual({ state: "attempting", failures: 1, updatedAt: "2026-06-10T00:00:00Z" });
    writeFileSync(join(dataDir, "server-sandbox-boot.json"), JSON.stringify({ state: "garbage", failures: -3 }));
    expect(readBootMarker()).toBeNull();
  });

  it("markServerSandboxHealthy is a no-op when unconfined (cannot clear trip evidence)", () => {
    writeBootMarker({ state: "attempting", failures: 2, updatedAt: "" });
    markServerSandboxHealthy();
    expect(readBootMarker()?.state).toBe("attempting");
    expect(readBootMarker()?.failures).toBe(2);
  });

  it("markServerSandboxHealthy resets the counter inside the confined child", () => {
    writeBootMarker({ state: "attempting", failures: 2, updatedAt: "" });
    process.env.LAX_SERVER_CONFINED = "1";
    markServerSandboxHealthy();
    expect(readBootMarker()).toMatchObject({ state: "healthy", failures: 0 });
  });
});

describe("maybeReexecServerConfined", () => {
  it("proceeds in-process when already confined", () => {
    process.env.LAX_SERVER_CONFINED = "1";
    process.env.LAX_SERVER_SANDBOX = "1";
    expect(isServerConfined()).toBe(true);
    expect(maybeReexecServerConfined()).toBe(false);
  });

  it("proceeds in-process when disabled (default)", () => {
    expect(maybeReexecServerConfined()).toBe(false);
    expect(readBootMarker()).toBeNull(); // no attempt recorded
  });

  it("never wraps the self_edit bind probe", () => {
    process.env.LAX_SERVER_SANDBOX = "1";
    process.env.LAX_SELF_EDIT_PROBE = "1";
    expect(maybeReexecServerConfined()).toBe(false);
    expect(readBootMarker()).toBeNull();
  });

  it("falls back unconfined when the escape hatch is tripped (config-enabled)", () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ serverSandbox: true }));
    writeBootMarker({ state: "attempting", failures: 2, updatedAt: "" });
    // On a non-darwin/non-linux box this returns false earlier (unusable);
    // either way it must NOT re-exec and must NOT increment the counter.
    expect(maybeReexecServerConfined()).toBe(false);
    expect(readBootMarker()?.failures).toBe(2);
  });
});

// The full re-exec (spawn + exit proxy) is exercised by the live boot check in
// CI/manual verification, not here — spawning a confined child that calls
// process.exit inside a vitest worker would kill the worker.
describe("boot marker file location", () => {
  it("lives under LAX_DATA_DIR (not hardcoded ~/.lax)", () => {
    writeBootMarker({ state: "healthy", failures: 0, updatedAt: "" });
    const onDisk = JSON.parse(readFileSync(join(dataDir, "server-sandbox-boot.json"), "utf-8"));
    expect(onDisk.state).toBe("healthy");
  });
});
