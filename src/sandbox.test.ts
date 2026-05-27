import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { validateSandboxConfig, execInSandbox } from "./sandbox.js";
import type { SandboxConfig } from "./sandbox-types.js";

// Sandbox config validator unit tests. These tests do NOT spawn docker —
// validateSandboxConfig() is pure, and execInSandbox() rejects bad config
// BEFORE invoking docker, so the integration smoke test (case 11) works even
// without a Docker daemon.

const DEFAULTS: SandboxConfig = {
  mode: "docker",
  image: "node:22-alpine",
  workspacePath: "/tmp/sandbox-test-ws",
  networkEnabled: false,
  extraMounts: [],
  memoryLimit: "512m",
};

function withMounts(mounts: string[], over: Partial<SandboxConfig> = {}): SandboxConfig {
  return { ...DEFAULTS, ...over, extraMounts: mounts };
}

describe("validateSandboxConfig", () => {
  it("accepts a sensible default config", () => {
    expect(validateSandboxConfig(DEFAULTS)).toEqual({ ok: true });
  });

  it("rejects ~/.ssh extraMount", () => {
    const r = validateSandboxConfig(withMounts(["~/.ssh/id_rsa:/root/.ssh/id_rsa"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.ssh/);
  });

  it("rejects ~/.aws extraMount", () => {
    const r = validateSandboxConfig(withMounts(["~/.aws:/aws"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.aws/);
  });

  it("rejects /etc/shadow extraMount", () => {
    const r = validateSandboxConfig(withMounts(["/etc/shadow:/etc/shadow"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\/etc\/shadow/);
  });

  it("rejects extraMount containing a 'secrets' segment", () => {
    const r = validateSandboxConfig(withMounts(["/home/x/secrets/foo:/foo"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/secrets/);
  });

  it("does NOT trip on substring matches like /var/log/credentialserver.log", () => {
    // Segment-exact check should leave this alone (credentialserver != credentials).
    const r = validateSandboxConfig(withMounts(["/var/log/credentialserver.log:/x"]));
    expect(r.ok).toBe(true);
  });

  it("rejects extraMount with .pem suffix", () => {
    const r = validateSandboxConfig(withMounts(["/tmp/cert.pem:/cert.pem"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.pem/);
  });

  it("rejects extraMount with .key suffix", () => {
    const r = validateSandboxConfig(withMounts(["/tmp/private.key:/k"]));
    expect(r.ok).toBe(false);
  });

  it("allows a benign /tmp extraMount", () => {
    const r = validateSandboxConfig(withMounts(["/tmp/somefile:/somefile"]));
    expect(r.ok).toBe(true);
  });

  it("rejects workspacePath = homedir", () => {
    const r = validateSandboxConfig({ ...DEFAULTS, workspacePath: homedir() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/workspacePath/);
  });

  it("rejects workspacePath = '/'", () => {
    const r = validateSandboxConfig({ ...DEFAULTS, workspacePath: "/" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/root/i);
  });

  it("rejects networkEnabled=true with any sensitive extraMount", () => {
    // The mount alone would reject; verify network override doesn't open a gap.
    const r = validateSandboxConfig(withMounts(["~/.ssh/id_rsa:/x"], { networkEnabled: true }));
    expect(r.ok).toBe(false);
  });

  it("rejects networkEnabled=true with any non-empty extraMounts (defense in depth)", () => {
    const r = validateSandboxConfig(withMounts(["/tmp/somefile:/x"], { networkEnabled: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/networkEnabled/);
  });

  it("rejects ~/.npmrc extraMount", () => {
    const r = validateSandboxConfig(withMounts([join(homedir(), ".npmrc") + ":/x"]));
    expect(r.ok).toBe(false);
  });

  it("rejects workspacePath inside ~/.ssh", () => {
    const r = validateSandboxConfig({ ...DEFAULTS, workspacePath: "~/.ssh/work" });
    expect(r.ok).toBe(false);
  });

  it("rejects extraMount with empty source", () => {
    const r = validateSandboxConfig(withMounts([":/dest"]));
    expect(r.ok).toBe(false);
  });

  it("rejects extraMount inside the LAX repo root", () => {
    // Default repo root is process.cwd() which during the test run IS the repo.
    const inRepo = process.cwd();
    const r = validateSandboxConfig(withMounts([`${inRepo}:/lax`]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/repo/i);
  });
});

describe("execInSandbox integration smoke (rejection path)", () => {
  it("returns exitCode 1 with a clear stderr when extraMounts is sensitive", () => {
    // No Docker invocation should occur — rejection happens before docker spawn.
    const result = execInSandbox("echo hi", { extraMounts: ["~/.ssh:/x"] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Sandbox config rejected/);
    expect(result.stdout).toBe("");
  });
});
