import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateSandboxConfig } from "./validate.js";
import type { SandboxConfig } from "./types.js";

// Focused tests for the validator's repo-root rule. sandbox.test.ts covers
// the breadth of deny rules (~/.ssh, /etc/shadow, segment names, suffixes,
// network-mount interaction); this file isolates the repo-root rule because
// that rule is what made the prior DEFAULT_CONFIG.workspacePath = "./workspace"
// unusable, and the rule's behavior depends on LAX_REPO_ROOT — a path of
// config that doesn't show up in the validator's signature.

function baseConfig(over: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    mode: "docker",
    image: "node:22-alpine",
    workspacePath: "/tmp/lax-sandbox-validate-test-ws",
    networkEnabled: false,
    extraMounts: [],
    memoryLimit: "512m",
    ...over,
  };
}

describe("validateSandboxConfig — repo-root rule", () => {
  let prevRepoRoot: string | undefined;
  let scratchRepo: string;

  beforeEach(() => {
    prevRepoRoot = process.env.LAX_REPO_ROOT;
    scratchRepo = mkdtempSync(join(tmpdir(), "lax-validate-repo-"));
    process.env.LAX_REPO_ROOT = scratchRepo;
  });

  afterEach(() => {
    if (prevRepoRoot === undefined) delete process.env.LAX_REPO_ROOT;
    else process.env.LAX_REPO_ROOT = prevRepoRoot;
    try { rmSync(scratchRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("rejects workspacePath inside LAX_REPO_ROOT", () => {
    const r = validateSandboxConfig(baseConfig({ workspacePath: join(scratchRepo, "workspace") }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/repo/i);
  });

  it("rejects workspacePath equal to LAX_REPO_ROOT itself", () => {
    const r = validateSandboxConfig(baseConfig({ workspacePath: scratchRepo }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/repo/i);
  });

  it("accepts workspacePath outside LAX_REPO_ROOT (sibling tmpdir)", () => {
    const sibling = mkdtempSync(join(tmpdir(), "lax-validate-outside-"));
    try {
      const r = validateSandboxConfig(baseConfig({ workspacePath: sibling }));
      expect(r.ok).toBe(true);
    } finally {
      try { rmSync(sibling, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // Confirms the fix for Bug 2: the default workspace path used by
  // execInSandbox (os.tmpdir()/lax-sandbox-workspace) sits outside any
  // reasonable LAX_REPO_ROOT and outside all other deny lists. Pinned here
  // so future drift on either the validator or DEFAULT_CONFIG trips a test.
  it("accepts the documented default workspace path under os.tmpdir()", () => {
    const r = validateSandboxConfig(baseConfig({
      workspacePath: join(tmpdir(), "lax-sandbox-workspace"),
    }));
    expect(r.ok).toBe(true);
  });
});

// Bug 6: a mount source like `/tmp/innocent -> /etc/shadow` passes lexical
// validation but docker follows the symlink at mount time, exposing the
// linked target inside the container. Validator now runs realpathSync after
// the literal-path deny check and re-checks the resolved path.
describe("validateSandboxConfig — symlink resolution (Bug 6)", () => {
  let prevRepoRoot: string | undefined;
  let scratchRepo: string;
  let scratchHost: string;

  beforeEach(() => {
    prevRepoRoot = process.env.LAX_REPO_ROOT;
    // realpath both scratch dirs so prefix comparisons line up — on macOS
    // tmpdir lives behind `/var -> /private/var`, and the validator compares
    // realpath'd mount sources against the env-declared (non-real) repo root.
    scratchRepo = realpathSync(mkdtempSync(join(tmpdir(), "lax-symlink-repo-")));
    process.env.LAX_REPO_ROOT = scratchRepo;
    scratchHost = realpathSync(mkdtempSync(join(tmpdir(), "lax-symlink-host-")));
  });

  afterEach(() => {
    if (prevRepoRoot === undefined) delete process.env.LAX_REPO_ROOT;
    else process.env.LAX_REPO_ROOT = prevRepoRoot;
    try { rmSync(scratchRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(scratchHost, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("rejects mount whose symlink resolves into the LAX repo root", () => {
    const targetInRepo = join(scratchRepo, "subdir");
    mkdirSync(targetInRepo);
    const link = join(scratchHost, "looks-safe");
    symlinkSync(targetInRepo, link);

    const r = validateSandboxConfig(baseConfig({ extraMounts: [`${link}:/container/x`] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/symlink/i);
      expect(r.reason).toMatch(/repo/i);
    }
  });

  it("accepts mount whose symlink resolves to another safe location", () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), "lax-symlink-target-")));
    try {
      const link = join(scratchHost, "safe-link");
      symlinkSync(target, link);
      const r = validateSandboxConfig(baseConfig({ extraMounts: [`${link}:/container/x`] }));
      expect(r.ok).toBe(true);
    } finally {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("rejects non-existent mount source with does-not-exist error", () => {
    const missing = join(scratchHost, "no-such-path");
    const r = validateSandboxConfig(baseConfig({ extraMounts: [`${missing}:/container/x`] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not exist/i);
  });

  it("rejects dangling symlink (target absent) with does-not-exist error", () => {
    const link = join(scratchHost, "dangling");
    symlinkSync(join(scratchHost, "missing-target"), link);
    const r = validateSandboxConfig(baseConfig({ extraMounts: [`${link}:/container/x`] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not exist/i);
  });

  it("regression: accepts plain safe path (no symlink involved)", () => {
    const safe = realpathSync(mkdtempSync(join(tmpdir(), "lax-symlink-plain-")));
    try {
      const r = validateSandboxConfig(baseConfig({ extraMounts: [`${safe}:/container/x`] }));
      expect(r.ok).toBe(true);
    } finally {
      try { rmSync(safe, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("regression: still rejects plain forbidden literal path", () => {
    const r = validateSandboxConfig(baseConfig({ extraMounts: ["/etc/shadow:/container/x"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/shadow/i);
  });
});

describe("validateSandboxConfig — workspacePath edge cases", () => {
  it("rejects empty workspacePath", () => {
    const r = validateSandboxConfig(baseConfig({ workspacePath: "" }));
    expect(r.ok).toBe(false);
  });

  it("rejects workspacePath of type other than string", () => {
    // Caller-side type erosion (JSON config, plugin passthrough) is the realistic
    // failure mode here. Cast forces the validator to run its runtime check.
    const r = validateSandboxConfig(baseConfig({ workspacePath: 123 as unknown as string }));
    expect(r.ok).toBe(false);
  });
});
