/**
 * Production bootstrap canary — `bootstrapCanonicalLoop()` must register
 * the default Anthropic adapter for the interactive lane when the feature
 * flag is on, and must be a no-op when the flag is off.
 *
 * Without this, op_submit takes the canonical route, persists the op as
 * `queued`, then fails on the next microtask with adapter_not_configured.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resetCanonicalRuntime,
  resolveAdapterFactory,
  ANTHROPIC_ADAPTER_NAME,
} from "../src/canonical-loop/index.js";
import { bootstrapCanonicalLoop } from "../src/server/canonical-loop-bootstrap.js";
import type { Op } from "../src/workers/types.js";

const LANE_ENVS = [
  "LAX_CANONICAL_LOOP_INTERACTIVE",
  "LAX_CANONICAL_LOOP_BUILD",
  "LAX_CANONICAL_LOOP_IDE",
  "LAX_CANONICAL_LOOP_BACKGROUND",
  "LAX_CANONICAL_LOOP_ALL",
];

const mkOp = (lane: Op["lane"]): Op => ({
  id: `bootstrap_test_${lane}`,
  type: "freeform",
  task: "noop",
  contextPack: {} as Op["contextPack"],
  lane,
  retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
  ownerId: "test",
  visibility: "private",
  status: "pending",
  createdAt: new Date().toISOString(),
  attemptCount: 0,
});

beforeEach(() => {
  for (const e of LANE_ENVS) delete process.env[e];
  resetCanonicalRuntime();
});

afterEach(() => {
  for (const e of LANE_ENVS) delete process.env[e];
  resetCanonicalRuntime();
});

describe("bootstrapCanonicalLoop", () => {
  it("flag OFF: registers nothing (legacy behavior unchanged)", () => {
    bootstrapCanonicalLoop();
    expect(resolveAdapterFactory(mkOp("interactive"))).toBeNull();
  });

  it("LAX_CANONICAL_LOOP_INTERACTIVE=1: registers AnthropicAdapter for interactive lane", async () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    bootstrapCanonicalLoop();
    const factory = resolveAdapterFactory(mkOp("interactive"));
    expect(factory).not.toBeNull();
    const adapter = await factory!();
    expect(adapter.name).toBe(ANTHROPIC_ADAPTER_NAME);
  });

  it("LAX_CANONICAL_LOOP_ALL=1: also registers interactive lane", async () => {
    process.env.LAX_CANONICAL_LOOP_ALL = "1";
    bootstrapCanonicalLoop();
    const factory = resolveAdapterFactory(mkOp("interactive"));
    expect(factory).not.toBeNull();
    const adapter = await factory!();
    expect(adapter.name).toBe(ANTHROPIC_ADAPTER_NAME);
  });

  it("interactive flag does NOT auto-register other lanes", () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    bootstrapCanonicalLoop();
    expect(resolveAdapterFactory(mkOp("build"))).toBeNull();
    expect(resolveAdapterFactory(mkOp("background"))).toBeNull();
  });
});
