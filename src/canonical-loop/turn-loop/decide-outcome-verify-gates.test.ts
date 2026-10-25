// The build-verify gate runs a real build. runCompletionGates hands every gate
// the op's cancel signal; this gate must pass it on so a Stop aborts the build
// instead of waiting up to its timeout.
import { describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";

vi.mock("./build-verify.js", () => ({
  runBuildVerifyGate: vi.fn(async () => ({ nudge: "", shouldRetry: false, capReached: false, verifiedClean: false, confirmation: "" })),
  groundTruthSizesNote: vi.fn(() => ""),
}));
vi.mock("../middlewares/verify-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middlewares/verify-gate.js")>()),
  opEditedSourceUnverified: vi.fn(() => true),
}));

// Entered through the chain module, the way the loop loads it: the gate
// modules form a cycle that only resolves from that end.
import { COMPLETION_GATES } from "./decide-outcome-gates.js";
import { runBuildVerifyGate } from "./build-verify.js";

const op = { id: "op-verify-gates" } as Op;
const buildVerifyGate = COMPLETION_GATES.find((g) => g.name === "build-verify")!;

describe("buildVerifyGate", () => {
  it("hands the chain's cancel signal to the build", async () => {
    const signal = new AbortController().signal;
    await buildVerifyGate.evaluate({ op, turnIdx: 0, toolCalls: [], assistantText: "", signal });
    expect(runBuildVerifyGate).toHaveBeenCalledWith(op, { signal });
  });
});
