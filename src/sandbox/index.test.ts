import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { validateSandboxConfig, execInSandbox, getSandboxMode, getSandboxStatus, wrapSpawnForSandbox, isGuardedUsable, sandboxDenialHint, setUnconfinedHostAcknowledgement } from "./index.js";
import type { SandboxConfig } from "./types.js";

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
  // Some tests need a real on-disk file as the mount source: the validator
  // now realpath-resolves sources (Bug 6 fix) and rejects missing paths.
  let scratchHost: string;
  let benignSource: string;

  beforeEach(() => {
    scratchHost = realpathSync(mkdtempSync(join(tmpdir(), "lax-sandbox-host-")));
    benignSource = join(scratchHost, "somefile");
    writeFileSync(benignSource, "");
  });

  afterEach(() => {
    try { rmSync(scratchHost, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

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

  it("does NOT trip on substring matches like credentialserver.log", () => {
    // Segment-exact check should leave this alone (credentialserver != credentials).
    // Source must exist on disk — realpath check rejects missing paths.
    const benign = join(scratchHost, "credentialserver.log");
    writeFileSync(benign, "");
    const r = validateSandboxConfig(withMounts([`${benign}:/x`]));
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

  it("allows a benign tmpdir extraMount", () => {
    const r = validateSandboxConfig(withMounts([`${benignSource}:/somefile`]));
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
    const r = validateSandboxConfig(withMounts([`${benignSource}:/x`], { networkEnabled: true }));
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

describe("guarded sandbox mode (default)", () => {
  const prev = process.env.LAX_SANDBOX;
  afterEach(() => { if (prev === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prev; });

  it("LAX_SANDBOX=guarded resolves to guarded where a kernel backend is usable, else host", () => {
    process.env.LAX_SANDBOX = "guarded";
    expect(getSandboxMode()).toBe(isGuardedUsable() ? "guarded" : "host");
  });

  it.skipIf(!isGuardedUsable())("guarded wrap applies the cage but keeps network (no network deny)", () => {
    process.env.LAX_SANDBOX = "guarded";
    const { cmd, args } = wrapSpawnForSandbox("/bin/bash", ["-c", "echo hi"]);
    // The cage is applied — not a bare passthrough...
    expect(cmd).not.toBe("/bin/bash");
    expect(args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
    // ...but network is NOT denied (the guarded difference vs strict seatbelt/bwrap).
    const blob = [cmd, ...args].join(" ");
    expect(blob).not.toContain("(deny network*)"); // seatbelt
    expect(blob).not.toContain("--unshare-net"); // bwrap
  });

  it.skipIf(isGuardedUsable())("guarded wrap is a passthrough where no kernel backend exists", () => {
    process.env.LAX_SANDBOX = "guarded";
    const { cmd, args } = wrapSpawnForSandbox("/bin/bash", ["-c", "echo hi"]);
    expect(cmd).toBe("/bin/bash");
    expect(args).toEqual(["-c", "echo hi"]);
  });
});

describe("effective sandbox status", () => {
  it("reports context-specific shell policy for an unacknowledged host", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    const prevMode = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_SANDBOX = "host";
    process.env.LAX_DATA_DIR = dataDir;
    try {
      const status = getSandboxStatus();
      expect(status).toMatchObject({
        selectedMode: "host",
        effectiveMode: "host",
        confined: false,
        unconfinedHostAcknowledged: false,
        cronShellAllowed: false,
        delegatedShellAllowed: false,
        apiShellAllowed: false,
      });

      setUnconfinedHostAcknowledgement(true);
      expect(getSandboxStatus()).toMatchObject({
        effectiveMode: "host",
        unconfinedHostAcknowledged: true,
        cronShellAllowed: false,
        delegatedShellAllowed: true,
        apiShellAllowed: true,
      });
    } finally {
      if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("surfaces guarded fallback instead of presenting the selected mode as effective", () => {
    const prev = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    process.env.LAX_SANDBOX = "guarded";
    process.env.LAX_DATA_DIR = dataDir;
    try {
      const status = getSandboxStatus();
      expect(status.selectedMode).toBe("guarded");
      expect(status.effectiveMode).toBe(isGuardedUsable() ? "guarded" : "host");
      expect(status.confined).toBe(isGuardedUsable());
      expect(status.cronShellAllowed).toBe(false);
      expect(status.delegatedShellAllowed).toBe(isGuardedUsable());
      expect(status.apiShellAllowed).toBe(isGuardedUsable());
      if (!isGuardedUsable()) expect(status.fallbackReason).toMatch(/unconfined/i);
    } finally {
      if (prev === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prev;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not carry acknowledgement across selected sandbox modes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    const prevMode = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "host";
    try {
      setUnconfinedHostAcknowledgement(true);
      expect(getSandboxStatus().unconfinedHostAcknowledged).toBe(true);
      process.env.LAX_SANDBOX = "guarded";
      expect(getSandboxStatus().unconfinedHostAcknowledged).toBe(false);
    } finally {
      if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists and revokes the host acknowledgement", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    const prevMode = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "host";
    try {
      setUnconfinedHostAcknowledgement(true);
      expect(getSandboxStatus().unconfinedHostAcknowledged).toBe(true);
      setUnconfinedHostAcknowledgement(false);
      expect(getSandboxStatus()).toMatchObject({
        unconfinedHostAcknowledged: false,
        delegatedShellAllowed: false,
        apiShellAllowed: false,
      });
    } finally {
      if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("sandboxDenialHint", () => {
  const epermAws = "cat: /Users/dad/.aws/credentials: Operation not permitted";

  it("names the cage + off switch when a credential dir is denied under a cage", () => {
    const hint = sandboxDenialHint("guarded", epermAws);
    expect(hint).toBeTruthy();
    expect(hint).toContain('mode "guarded"');
    expect(hint).toContain("~/.aws");
    expect(hint).toMatch(/Settings/);
  });

  it("fires for seatbelt and bwrap too", () => {
    expect(sandboxDenialHint("seatbelt", "ls: /Users/dad/.ssh: Operation not permitted")).toContain("~/.ssh");
    expect(sandboxDenialHint("bwrap", "Permission denied: /home/u/.kube/config")).toContain("~/.kube");
  });

  it("returns null in host/docker mode (no kernel cage to blame)", () => {
    expect(sandboxDenialHint("host", epermAws)).toBeNull();
    expect(sandboxDenialHint("docker", epermAws)).toBeNull();
  });

  it("returns null on an ordinary permission error with no cage-denied path", () => {
    expect(sandboxDenialHint("guarded", "cat: /etc/secret: Permission denied")).toBeNull();
  });

  it("returns null on a non-permission failure", () => {
    expect(sandboxDenialHint("guarded", "bash: frobnicate: command not found")).toBeNull();
  });

  it("does NOT blame the cage for ~/.config — guarded exempts it", () => {
    // ~/.config is readable in guarded, so an EPERM mentioning it is a real error.
    expect(sandboxDenialHint("guarded", "open /Users/dad/.config/x: Operation not permitted")).toBeNull();
    // ...but strict seatbelt DOES deny ~/.config, so there it's the cage.
    expect(sandboxDenialHint("seatbelt", "open /Users/dad/.config/x: Operation not permitted")).toContain("~/.config");
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

  // Regression guard: execInSandbox() must not fail validation on its own
  // defaults. Previously DEFAULT_CONFIG.workspacePath was "./workspace",
  // which resolved into the repo root and the validator rejected — making
  // docker-mode bash always return "Sandbox config rejected: ..." since
  // the only real caller (shell-tools.ts) passes no override.
  it("does NOT reject validation when called with no config override", () => {
    // Docker is probably not running in CI/test envs; we only assert that
    // we got past validation. If validation rejected, stderr would start
    // with "Sandbox config rejected". After the docker spawn it'll be some
    // other error (docker not installed, image not found, etc.) — that's
    // fine, the validation gate is what we care about.
    const result = execInSandbox("echo hi");
    expect(result.stderr).not.toMatch(/Sandbox config rejected/);
  });
});
