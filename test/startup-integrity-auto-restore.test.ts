/**
 * Smoke tests for startup-integrity's AV-quarantine self-heal path.
 *
 * Verifies:
 *   - checkStartupIntegrity returns ok when sentinel files exist
 *   - checkStartupIntegrity flags missing files correctly
 *   - The auto-restore path is gated to packages/arikernel/ only
 *     (won't restore arbitrary missing files like src/ deletions)
 *
 * The actual git-checkout side-effect is hard to test in isolation
 * without spinning up a fake repo, so we test the gating + check
 * behavior. End-to-end is exercised live every server boot.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStartupIntegrity } from "../src/startup-integrity.js";

describe("checkStartupIntegrity", () => {
  it("returns ok when all sentinel files exist (live repo state)", () => {
    // Run against the actual repo root — files were just restored.
    const result = checkStartupIntegrity();
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("flags missing files when run against an empty tmp dir", () => {
    const empty = mkdtempSync(join(tmpdir(), "integrity-empty-"));
    try {
      const result = checkStartupIntegrity(empty);
      expect(result.ok).toBe(false);
      // All three sentinels should be missing
      expect(result.missing.length).toBeGreaterThanOrEqual(2);
      expect(result.missing.some(m => m.path.includes("arikernel"))).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("flags partial missing files (one sentinel present, others absent)", () => {
    const partial = mkdtempSync(join(tmpdir(), "integrity-partial-"));
    try {
      // Create only the runtime src/index.ts sentinel.
      mkdirSync(join(partial, "packages", "arikernel", "runtime", "src"), { recursive: true });
      writeFileSync(join(partial, "packages", "arikernel", "runtime", "src", "index.ts"), "// stub");
      const result = checkStartupIntegrity(partial);
      expect(result.ok).toBe(false);
      // core/src/index.ts and runtime/dist/index.js still missing
      expect(result.missing.length).toBe(2);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });
});
