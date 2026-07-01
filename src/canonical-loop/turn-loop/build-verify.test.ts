import { describe, it, expect, vi, beforeEach } from "vitest";

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
} from "./build-verify.js";
import { recordOrchestratorVerify } from "../middlewares/verify-gate.js";
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
  });

  it("on a GREEN build: lets done stand and records the verdict as passed", async () => {
    const exec = vi.fn(GREEN);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", true);
    expect(getBuildVerifyRetries("op-bv")).toBe(0);
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
  });

  it("no edited paths: no-op", async () => {
    const exec = vi.fn(RED);
    const r = await runBuildVerifyGate(op, { editedPaths: [], probe, exec });
    expect(r.shouldRetry).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
