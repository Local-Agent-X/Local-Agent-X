/**
 * Tests for the self_edit rollback record (persistence + one-time boot notice).
 *
 * We exercise the parts that don't need a live git repo:
 *   - recordMerge → readLastMerge round-trip
 *   - readLastMerge() returns null when no record exists
 *   - surfaceUnacknowledgedMerge() flips `surfaced` exactly once
 *
 * We deliberately do NOT test revertLastMerge / runRepoBuild / the git
 * primitives — they require a live repo and a real build, and are exercised
 * end-to-end by the self_edit sandbox flow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "self-edit-rollback-"));
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const sample = {
  preSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  postSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  baseBranch: "main",
  repoRoot: "/repo",
  files: 3,
  ts: "2026-05-30T00:00:00.000Z",
};

describe("self-edit-rollback", () => {
  it("round-trips recordMerge → readLastMerge with surfaced=false", async () => {
    const { recordMerge, readLastMerge } = await import("../src/self-edit-rollback.js");
    recordMerge(sample);
    const rec = readLastMerge();
    expect(rec).not.toBeNull();
    expect(rec!.preSha).toBe(sample.preSha);
    expect(rec!.postSha).toBe(sample.postSha);
    expect(rec!.baseBranch).toBe(sample.baseBranch);
    expect(rec!.repoRoot).toBe(sample.repoRoot);
    expect(rec!.files).toBe(sample.files);
    expect(rec!.ts).toBe(sample.ts);
    expect(rec!.surfaced).toBe(false);
  });

  it("readLastMerge() returns null when no record exists", async () => {
    const { readLastMerge } = await import("../src/self-edit-rollback.js");
    expect(readLastMerge()).toBeNull();
  });

  it("surfaceUnacknowledgedMerge() flips surfaced to true exactly once", async () => {
    const { recordMerge, readLastMerge, surfaceUnacknowledgedMerge } =
      await import("../src/self-edit-rollback.js");
    recordMerge(sample);
    surfaceUnacknowledgedMerge();
    expect(readLastMerge()!.surfaced).toBe(true);
    // Idempotent — calling again is a no-op and must not throw.
    expect(() => surfaceUnacknowledgedMerge()).not.toThrow();
    expect(readLastMerge()!.surfaced).toBe(true);
  });

  it("recordMerge starts boot-pending with zero attempts", async () => {
    const { recordMerge, readLastMerge } = await import("../src/self-edit-rollback.js");
    recordMerge(sample);
    const rec = readLastMerge()!;
    expect(rec.bootPending).toBe(true);
    expect(rec.bootAttempts).toBe(0);
  });

  it("confirmMergeBoot clears the boot-pending flag", async () => {
    const { recordMerge, readLastMerge, confirmMergeBoot } = await import("../src/self-edit-rollback.js");
    recordMerge(sample);
    confirmMergeBoot();
    expect(readLastMerge()!.bootPending).toBe(false);
  });

  it("crashed-merge guard: first boot only records an attempt, second boot reverts", async () => {
    const { recordMerge, readLastMerge, revertPendingMergeIfCrashed } =
      await import("../src/self-edit-rollback.js");
    recordMerge(sample);

    // First boot after the merge: don't revert (it hasn't tried to bind yet) —
    // just record the attempt.
    expect(revertPendingMergeIfCrashed()).toBeNull();
    expect(readLastMerge()!.bootAttempts).toBe(1);
    expect(readLastMerge()!.bootPending).toBe(true);

    // Second boot still finds it pending → prior attempt never bound → revert.
    // (repoRoot "/repo" doesn't exist, so the git revert fails fast — we assert
    // the guard fired and cleared pending, not the git outcome.)
    const result = revertPendingMergeIfCrashed();
    expect(result).not.toBeNull();
    expect(readLastMerge()!.bootPending).toBe(false);
  });

  it("crashed-merge guard is a no-op once boot is confirmed", async () => {
    const { recordMerge, confirmMergeBoot, revertPendingMergeIfCrashed } =
      await import("../src/self-edit-rollback.js");
    recordMerge(sample);
    confirmMergeBoot();
    expect(revertPendingMergeIfCrashed()).toBeNull();
  });
});
