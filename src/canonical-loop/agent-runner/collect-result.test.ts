// An agent run's outcome is read from its op's terminal status, the one
// reading resolveTerminalOpStatus gives every surface: a run the worker ended
// at an iteration checkpoint is `succeeded` on the state machine but did not
// finish, and the spawned-agent driver used to report it, and a failed or
// cancelled run with text, as a success.
import { describe, it, expect, vi } from "vitest";

const partialOps = new Set<string>();
vi.mock("../checkpoint-stop.js", () => ({
  resolveTerminalOpStatus: (opId: string, state: string) => ({
    status: state === "succeeded" ? (partialOps.has(opId) ? "partial" : "completed") : state === "cancelled" ? "cancelled" : "failed",
    stop: null,
    partialSummary: null,
  }),
}));

const { agentRunShortfall, mapStopReason } = await import("./collect-result.js");

describe("an agent run's stop reason", () => {
  it("is end_turn only for a run that finished", () => {
    expect(mapStopReason("op-done", "succeeded", undefined)).toBe("end_turn");
  });

  it("is max_iterations for a run that stopped at a checkpoint", () => {
    partialOps.add("op-partial");
    expect(mapStopReason("op-partial", "succeeded", undefined)).toBe("max_iterations");
  });

  it("is abort for a cancelled run and error for a failed one", () => {
    expect(mapStopReason("op-c", "cancelled", undefined)).toBe("abort");
    expect(mapStopReason("op-f", "failed", "max_turns_exceeded")).toBe("max_iterations");
    expect(mapStopReason("op-f", "failed", "provider_error")).toBe("error");
  });
});

describe("agentRunShortfall", () => {
  it("is null for a finished run and names the reason otherwise", () => {
    expect(agentRunShortfall({ stopReason: "end_turn" })).toBeNull();
    expect(agentRunShortfall({ stopReason: "abort" })).toMatch(/cancelled/);
    expect(agentRunShortfall({ stopReason: "max_iterations" })).toMatch(/before finishing/);
    expect(agentRunShortfall({ stopReason: "error", errorMessage: "rate_limit: slow down" })).toBe("the run failed: rate_limit: slow down");
  });
});
