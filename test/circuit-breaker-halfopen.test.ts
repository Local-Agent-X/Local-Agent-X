import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  checkCircuit,
  recordCircuitSuccess,
  recordCircuitFailure,
  resetAllCircuits,
  configureCircuitBreaker,
} from "../src/circuit-breaker.js";
import { CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS } from "../src/resilience-policy.js";

// The breaker keys on (sessionId, toolName) and reads Date.now() live, so we
// drive time with fake timers / setSystemTime and reset module state per test.
const SID = "sess-1";
const TOOL = "bash";
const THRESHOLD = CIRCUIT_FAILURE_THRESHOLD; // 4
const COOLDOWN = CIRCUIT_COOLDOWN_MS; // 30_000

function fail(n: number): void {
  for (let i = 0; i < n; i++) recordCircuitFailure(SID, TOOL, "boom");
}

describe("circuit-breaker state machine", () => {
  beforeEach(() => {
    resetAllCircuits();
    // Pin defaults explicitly so a prior test's configure() can't bleed in.
    configureCircuitBreaker({ failureThreshold: THRESHOLD, cooldownMs: COOLDOWN });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAllCircuits();
  });

  it("starts closed and allows calls", () => {
    const d = checkCircuit(SID, TOOL);
    expect(d.allowed).toBe(true);
    expect(d.state).toBe("closed");
    expect(d.consecutiveFailures).toBe(0);
  });

  it("stays closed below the failure threshold", () => {
    fail(THRESHOLD - 1);
    const d = checkCircuit(SID, TOOL);
    expect(d.allowed).toBe(true);
    expect(d.state).toBe("closed");
    expect(d.consecutiveFailures).toBe(THRESHOLD - 1);
  });

  it("opens once consecutive failures reach the threshold", () => {
    fail(THRESHOLD);
    const d = checkCircuit(SID, TOOL);
    expect(d.allowed).toBe(false);
    expect(d.state).toBe("open");
    expect(d.consecutiveFailures).toBe(THRESHOLD);
    expect(d.reason).toContain(TOOL);
    expect(d.userHint).toBeDefined();
  });

  it("rejects fast while open and before cooldown elapses", () => {
    fail(THRESHOLD);
    // advance partway through cooldown — still open
    vi.advanceTimersByTime(COOLDOWN - 1);
    const d = checkCircuit(SID, TOOL);
    expect(d.allowed).toBe(false);
    expect(d.state).toBe("open");
    // reason should surface a remaining-seconds hint
    expect(d.reason).toMatch(/wait \d+s/);
  });

  it("transitions to half_open once the cooldown elapses", () => {
    fail(THRESHOLD);
    vi.advanceTimersByTime(COOLDOWN);
    const d = checkCircuit(SID, TOOL);
    expect(d.allowed).toBe(true);
    expect(d.state).toBe("half_open");
  });

  it("a success in half_open closes the breaker and resets the counter", () => {
    fail(THRESHOLD);
    vi.advanceTimersByTime(COOLDOWN);
    expect(checkCircuit(SID, TOOL).state).toBe("half_open");

    recordCircuitSuccess(SID, TOOL);

    const d = checkCircuit(SID, TOOL);
    expect(d.allowed).toBe(true);
    expect(d.state).toBe("closed");
    expect(d.consecutiveFailures).toBe(0);
  });

  it("a failure in half_open re-opens immediately with a fresh cooldown", () => {
    fail(THRESHOLD);
    vi.advanceTimersByTime(COOLDOWN);
    expect(checkCircuit(SID, TOOL).state).toBe("half_open");

    // Single failure while half-open → re-open right away.
    recordCircuitFailure(SID, TOOL, "still broken");

    const d = checkCircuit(SID, TOOL);
    expect(d.allowed).toBe(false);
    expect(d.state).toBe("open");

    // openedAt was reset on re-open: advancing a full new cooldown re-arms half_open.
    vi.advanceTimersByTime(COOLDOWN);
    expect(checkCircuit(SID, TOOL).state).toBe("half_open");
  });

  it("a success in closed state clears accumulated failures", () => {
    fail(THRESHOLD - 1);
    recordCircuitSuccess(SID, TOOL);
    const d = checkCircuit(SID, TOOL);
    expect(d.state).toBe("closed");
    expect(d.consecutiveFailures).toBe(0);
  });

  it("isolates breakers per (session, tool) key", () => {
    fail(THRESHOLD); // trips SID/TOOL
    expect(checkCircuit(SID, TOOL).state).toBe("open");

    // Different tool, same session — unaffected.
    expect(checkCircuit(SID, "read").state).toBe("closed");
    // Different session, same tool — unaffected.
    expect(checkCircuit("sess-2", TOOL).state).toBe("closed");
  });
});

// Regression (2026-07-02 auto-build chunk 2): four reads of ONE wrong path
// opened the per-tool breaker and the worker lost `read` for the whole run.
// The breaker keys on the call signature now — the identical failing call
// trips; the tool stays usable with different arguments.
describe("per-call-signature keying", () => {
  beforeEach(() => {
    resetAllCircuits();
    configureCircuitBreaker({ failureThreshold: THRESHOLD, cooldownMs: COOLDOWN });
  });
  afterEach(() => resetAllCircuits());

  it("failures with varied args never share a breaker", () => {
    for (let i = 0; i < THRESHOLD; i++) {
      recordCircuitFailure(SID, "read", "File not found", `{"path":"a${i}.md"}`);
    }
    expect(checkCircuit(SID, "read", '{"path":"b.md"}').allowed).toBe(true);
    expect(checkCircuit(SID, "read", '{"path":"a0.md"}').allowed).toBe(true);
  });

  it("the identical failing call trips only its own signature", () => {
    const sig = '{"path":"missing.md"}';
    for (let i = 0; i < THRESHOLD; i++) {
      recordCircuitFailure(SID, "read", "File not found", sig);
    }
    expect(checkCircuit(SID, "read", sig).allowed).toBe(false);
    expect(checkCircuit(SID, "read", sig).reason).toContain("same arguments");
    // The tool itself stays usable — the live-failure regression.
    expect(checkCircuit(SID, "read", '{"path":"other.md"}').allowed).toBe(true);
    // A success on the failing signature clears it.
    recordCircuitSuccess(SID, "read", sig);
    expect(checkCircuit(SID, "read", sig).allowed).toBe(true);
  });
});
