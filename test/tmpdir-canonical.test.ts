/**
 * Regression lock for the TMPDIR-symlink class.
 *
 * macOS hands every process a symlinked TMPDIR (/var/folders/… →
 * /private/var/folders/…). Hundreds of fixtures mint temp roots via
 * mkdtempSync(join(tmpdir(), …)) and compare them against product output
 * that canonicalizes paths — so the shared setup (test/setup/test-env.ts)
 * realpaths TMPDIR before any test file runs. If this test fails, that
 * seam regressed and the whole "/var vs /private/var" failure class
 * (~150 tests) comes back.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("canonical temp root (test/setup/test-env.ts seam)", () => {
  it("os.tmpdir() is already canonical — no symlinked ancestors", () => {
    expect(realpathSync(tmpdir())).toBe(tmpdir());
  });

  it("a minted temp root round-trips through realpath unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "tmpdir-canonical-"));
    try {
      expect(realpathSync(root)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("child processes inherit the canonical temp root", () => {
    // Children spawned with `env: { ...process.env }` must resolve the same
    // canonical root, or product-side realpath output diverges again.
    expect(process.env.TMPDIR).toBe(tmpdir());
  });
});
