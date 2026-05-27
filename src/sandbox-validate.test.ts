import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateSandboxConfig } from "./sandbox-validate.js";
import type { SandboxConfig } from "./sandbox-types.js";

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
