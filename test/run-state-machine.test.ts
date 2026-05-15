/**
 * Tests for the Run state machine — the canonical contract documented
 * in src/agents/run.ts. Runtime guarantees the type system can't:
 *
 *   - Terminal statuses match the canonical-loop's TERMINAL_STATES (so
 *     run records and op events speak the same vocabulary — F13).
 *   - isTerminalStatus agrees with TERMINAL_STATUSES (so consumers
 *     can use either form).
 *
 * Type-level compatibility (FieldAgent / AgentRun satisfy Run) is
 * verified by the TypeScript compiler at build time — no runtime
 * assertion needed.
 */

import { describe, it, expect } from "vitest";
import { TERMINAL_STATUSES, isTerminalStatus, type RunStatus } from "../src/agents/run.js";
import { TERMINAL_STATES } from "../src/canonical-loop/terminal-states.js";

describe("Run state machine", () => {
  it("TERMINAL_STATUSES matches canonical TERMINAL_STATES (F13)", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([...TERMINAL_STATES].sort());
  });

  it("isTerminalStatus agrees with TERMINAL_STATUSES for every RunStatus", () => {
    const all: RunStatus[] = ["idle", "working", "waiting", "succeeded", "failed", "cancelled"];
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
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });
});
