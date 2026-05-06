/**
 * Soak telemetry test-mode guard.
 *
 * Regression for: vitest runs canonical-loop tests through the real
 * seam, which appends a row per test op to workspace/canonical-loop-
 * soak.jsonl and inflates the production daily roll-up. The fix
 * short-circuits the soak hook when `VITEST` or `NODE_ENV === "test"`
 * is set.
 */
import { describe, expect, it, afterEach } from "vitest";
import { existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  recordCanonicalEvent,
  recordStreamChunk,
  _resetSoakMetricsForTests,
} from "../src/canonical-loop/soak-metrics.js";
import type { CanonicalEvent } from "../src/canonical-loop/types.js";

const SOAK_LOG_PATH = join(process.cwd(), "workspace", "canonical-loop-soak.jsonl");

function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

function mkEvent(type: CanonicalEvent["type"], body: Record<string, unknown> | null): CanonicalEvent {
  return {
    opId: "soak-metrics-guard-test",
    seq: 0,
    type,
    ts: new Date().toISOString(),
    body,
  };
}

afterEach(() => {
  _resetSoakMetricsForTests();
});

describe("soak-metrics test-mode guard", () => {
  it("VITEST env causes recordCanonicalEvent to be a no-op (no JSONL append)", () => {
    expect(process.env.VITEST).toBeTruthy();
    const before = fileSize(SOAK_LOG_PATH);

    // Drive a full op lifecycle through the hook. With VITEST set, the
    // sink must skip every event and append nothing.
    recordCanonicalEvent(mkEvent("state_changed", { from: null, to: "queued", reason: "submitted" }));
    recordCanonicalEvent(mkEvent("lease_acquired", { workerId: "w-test" }));
    recordCanonicalEvent(mkEvent("state_changed", { from: "queued", to: "running", reason: "leased" }));
    recordStreamChunk("soak-metrics-guard-test");
    recordCanonicalEvent(mkEvent("turn_committed", { turnIdx: 0 }));
    recordCanonicalEvent(mkEvent("state_changed", { from: "running", to: "succeeded", reason: "turn_done" }));

    expect(fileSize(SOAK_LOG_PATH)).toBe(before);

    // And the JSONL should not contain this opId, even if the file
    // exists from earlier traffic.
    if (existsSync(SOAK_LOG_PATH)) {
      const raw = readFileSync(SOAK_LOG_PATH, "utf-8");
      expect(raw).not.toContain("soak-metrics-guard-test");
    }
  });

  it("NODE_ENV=test (without VITEST) also short-circuits", () => {
    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "test";
    try {
      const before = fileSize(SOAK_LOG_PATH);
      recordCanonicalEvent(mkEvent("state_changed", { from: null, to: "queued", reason: "submitted" }));
      recordCanonicalEvent(mkEvent("state_changed", { from: "running", to: "succeeded", reason: "turn_done" }));
      expect(fileSize(SOAK_LOG_PATH)).toBe(before);
    } finally {
      if (prevVitest !== undefined) process.env.VITEST = prevVitest;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });
});
