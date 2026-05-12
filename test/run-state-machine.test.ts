/**
 * Tests for the Run state machine — the canonical contract documented
 * in src/agents/run.ts. Runtime guarantees the type system can't:
 *
 *   - Terminal statuses match the documented set (no drift between
 *     the type and the constant).
 *   - isTerminalStatus agrees with TERMINAL_STATUSES (so consumers
 *     can use either form).
 *
 * Type-level compatibility (FieldAgent / AgentRun satisfy Run) is
 * verified by the TypeScript compiler at build time — no runtime
 * assertion needed.
 */

import { describe, it, expect } from "vitest";
import { TERMINAL_STATUSES, isTerminalStatus, type RunStatus } from "../src/agents/run.js";

describe("Run state machine", () => {
  it("TERMINAL_STATUSES is exactly { done, error, cancelled, timeout }", () => {
    const sorted = [...TERMINAL_STATUSES].sort();
    expect(sorted).toEqual(["cancelled", "done", "error", "timeout"]);
  });

  it("isTerminalStatus agrees with TERMINAL_STATUSES for every RunStatus", () => {
    const all: RunStatus[] = ["idle", "working", "waiting", "done", "error", "cancelled", "timeout"];
    for (const s of all) {
      expect(isTerminalStatus(s)).toBe(TERMINAL_STATUSES.has(s));
    }
  });

  it("non-terminal statuses do not classify as terminal", () => {
    expect(isTerminalStatus("idle")).toBe(false);
    expect(isTerminalStatus("working")).toBe(false);
    expect(isTerminalStatus("waiting")).toBe(false);
  });

  it("terminal statuses classify as terminal", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("error")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("timeout")).toBe(true);
  });
});
