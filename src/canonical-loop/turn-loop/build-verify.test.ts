import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The gate writes its verdict into the verify-gate ledger and reads edited
// paths from it. Mock that seam so the test isolates the gate's own control
// flow (detect → run → record → retry/cap) without standing up middleware state.
vi.mock("../middlewares/verify-gate.js", () => ({
  opEditedSourcePaths: vi.fn(() => [] as string[]),
  recordOrchestratorVerify: vi.fn(),
}));

import {
  runBuildVerifyGate,
  getBuildVerifyRetries,
  _resetBuildVerifyState,
  groundTruthSizesNote,
} from "./build-verify.js";
import { recordOrchestratorVerify, opEditedSourcePaths } from "../middlewares/verify-gate.js";
import type { FsProbe } from "../../agent-guards/index.js";
import type { Op } from "../../ops/types.js";

const op = { id: "op-bv" } as unknown as Op;

// A probe describing one buildable TS project at /proj (typecheck script).
const probe: FsProbe = {
  exists: (p) => p === "/proj/package.json",
  readJson: (p) => (p === "/proj/package.json" ? { scripts: { typecheck: "tsc --noEmit" } } : null),
};

const RED = async () => ({ ok: false, output: "src/a.ts(3,5): error TS2339: Property 'x' does not exist." });
const GREEN = async () => ({ ok: true, output: "" });

// A project at /proj with a typecheck script AND a local vitest binary — so a
// test file edit triggers the edited-test pass on top of the type-check.
const probeWithVitest: FsProbe = {
  exists: (p) => p === "/proj/package.json" || p === "/proj/node_modules/.bin/vitest",
  readJson: (p) => (p === "/proj/package.json" ? { scripts: { typecheck: "tsc --noEmit" } } : null),
};

// An exec that answers by command: the vitest run vs the type-check.
const byCommand = (typecheckOk: boolean, testOk: boolean) =>
  vi.fn(async (command: string) =>
    command.includes("vitest")
      ? { ok: testOk, output: testOk ? "" : "FAIL foo.test.ts > keeps user msg — expected 6 got 5" }
      : { ok: typecheckOk, output: typecheckOk ? "" : "src/a.ts(3,5): error TS2339" },
  );

describe("runBuildVerifyGate", () => {
  beforeEach(() => {
    _resetBuildVerifyState();
    vi.clearAllMocks();
  });

  it("on a RED build: injects errors, asks to retry, records the verdict as failed", async () => {
    const exec = vi.fn(RED);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(exec).toHaveBeenCalledWith("npm run typecheck", "/proj");
    expect(r.shouldRetry).toBe(true);
    expect(r.capReached).toBe(false);
    expect(r.nudge).toContain("npm run typecheck");
    expect(r.nudge).toContain("TS2339");
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", false);
    expect(getBuildVerifyRetries("op-bv")).toBe(1);
    // A red build is never rounded up to a clean confirmation.
    expect(r.verifiedClean).toBe(false);
    expect(r.confirmation).toBe("");
  });

  it("on a GREEN build: lets done stand, records passed, and confirms clean for the record", async () => {
    const exec = vi.fn(GREEN);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", true);
    expect(getBuildVerifyRetries("op-bv")).toBe(0);
    // Reconcile-on-green: a real pass surfaces a positive confirmation so a
    // model that couldn't self-verify doesn't leave "unverified" as the last word.
    expect(r.verifiedClean).toBe(true);
    expect(r.confirmation).toContain("Verified");
    expect(r.confirmation).toContain("npm run typecheck");
  });

  it("green build's confirmation stays size-free (sizes are a separate op-end note)", async () => {
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec: vi.fn(GREEN) });
    expect(r.verifiedClean).toBe(true);
    expect(r.confirmation).not.toContain("Ground-truth size");
  });

  it("caps the fix loop: past MAX_RETRIES it stops retrying but still reports red", async () => {
    const exec = vi.fn(RED);
    const run = () => runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect((await run()).shouldRetry).toBe(true); // retry 1
    expect((await run()).shouldRetry).toBe(true); // retry 2
    const third = await run();                    // cap
    expect(third.shouldRetry).toBe(false);
    expect(third.capReached).toBe(true);
    expect(third.nudge).toContain("TS2339"); // errors still surfaced, just not looped on
  });

  it("no buildable project found: never runs anything, never records a verdict", async () => {
    const empty: FsProbe = { exists: () => false, readJson: () => null };
    const exec = vi.fn(RED);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/nowhere/a.ts"], probe: empty, exec });
    expect(r.shouldRetry).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(recordOrchestratorVerify).not.toHaveBeenCalled();
    // "no buildable project" is NOT a clean verify — it must not confirm.
    expect(r.verifiedClean).toBe(false);
    expect(r.confirmation).toBe("");
  });

  it("no edited paths: no-op", async () => {
    const exec = vi.fn(RED);
    const r = await runBuildVerifyGate(op, { editedPaths: [], probe, exec });
    expect(r.shouldRetry).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("edited test that FAILS: type-check passes but the test is red → nudge + retry, records partial", async () => {
    const exec = byCommand(true, false);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec });
    expect(exec).toHaveBeenCalledWith("npm run typecheck", "/proj");
    expect(exec).toHaveBeenCalledWith("node_modules/.bin/vitest run src/foo.test.ts", "/proj");
    expect(r.shouldRetry).toBe(true);
    expect(r.verifiedClean).toBe(false);
    expect(r.nudge).toMatch(/test you touched is FAILING/i);
    expect(r.nudge).toContain("vitest run src/foo.test.ts");
    // A type-clean-but-test-red edit records partial, not clean.
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", false);
  });

  it("edited test that PASSES: type-check + test both green → verifiedClean, confirmation names both", async () => {
    const exec = byCommand(true, true);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec });
    expect(r.verifiedClean).toBe(true);
    expect(r.confirmation).toContain("npm run typecheck");
    expect(r.confirmation).toContain("vitest run src/foo.test.ts");
    expect(recordOrchestratorVerify).toHaveBeenLastCalledWith("op-bv", true);
  });

  it("edited test but type-check FAILS: stops at the type-check, never runs the test", async () => {
    const exec = byCommand(false, true);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("TS2339");
    expect(exec).toHaveBeenCalledTimes(1); // type-check only; test pass skipped while red
    expect(exec).not.toHaveBeenCalledWith("node_modules/.bin/vitest run src/foo.test.ts", "/proj");
  });
});

describe("groundTruthSizesNote — real file sizes when the model quotes one", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the wc -l line count of edited files when the reply quotes a size", () => {
    // 137 newlines → `wc -l` == 137; a reply claiming any other number (e.g. 294)
    // is contradicted by this authoritative note.
    const dir = mkdtempSync(join(tmpdir(), "bv-size-"));
    try {
      const file = join(dir, "big.ts");
      writeFileSync(file, "const x = 1;\n".repeat(137));
      vi.mocked(opEditedSourcePaths).mockReturnValueOnce([file]);
      const note = groundTruthSizesNote("op-bv", "Done — big.ts is now 294 lines, clean split.");
      expect(note).not.toBeNull();
      expect(note).toContain("137 lines");
      expect(note).toContain("wc -l");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent (null) when the reply quotes NO size — zero noise on normal edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "bv-size-"));
    try {
      const file = join(dir, "big.ts");
      writeFileSync(file, "const x = 1;\n".repeat(10));
      vi.mocked(opEditedSourcePaths).mockReturnValueOnce([file]);
      expect(groundTruthSizesNote("op-bv", "Done — renamed the type across the repo, tsc clean.")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when a size was quoted but no source file was edited", () => {
    vi.mocked(opEditedSourcePaths).mockReturnValueOnce([]);
    expect(groundTruthSizesNote("op-bv", "The file is 400 lines.")).toBeNull();
  });
});
