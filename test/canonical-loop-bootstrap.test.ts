/**
 * Production bootstrap canary — `bootstrapCanonicalLoop()` must register
 * the default Anthropic adapter for the interactive lane when the feature
 * flag is on, and must be a no-op when the flag is off.
 *
 * Without this, op_submit takes the canonical route, persists the op as
 * `queued`, then fails on the next microtask with adapter_not_configured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { configSchema } from "../src/config-schema.js";
import { setRuntimeConfig } from "../src/config.js";
import {
  resetCanonicalRuntime,
  resolveAdapterFactory,
  ANTHROPIC_ADAPTER_NAME,
} from "../src/canonical-loop/index.js";
// Load the transport graph BEFORE the tests run. AnthropicAdapter's
// constructor fire-and-forgets `import("./anthropic-transport.js")` into a
// private promise this test never awaits (it never calls runTurn). Under a
// loaded transform server that import can still be in flight when this file's
// environment is torn down, and it then rejects with vitest's
// EnvironmentTeardownError — one unhandled rejection per constructed adapter
// (4 lanes), forcing suite exit 1 at zero failures. With the module already
// evaluated here, the constructor's dynamic import settles from the module
// registry on a microtask inside the test's own lifetime.
import "../src/canonical-loop/adapters/anthropic-transport.js";
import { bootstrapCanonicalLoop } from "../src/server/canonical-loop-bootstrap.js";
import { isRecoveryJanitorStarted, stopRecoveryJanitor } from "../src/canonical-loop/recovery-janitor.js";
import type { Op } from "../src/ops/types.js";

// bootstrapCanonicalLoop() reconciles learned outcomes at boot, which mkdirs
// <config.workspace>/protocols/effectiveness (learned-effectiveness ledger).
// With no runtime config installed, the getRuntimeConfig() fallback loads the
// default workspace "./workspace" and resolves it against the vitest fork's
// cwd — the repo checkout — planting untracked workspace/protocols/ cruft in
// the working tree on every suite run. Pin the workspace to a temp root.
const WORKSPACE = mkdtempSync(join(tmpdir(), "canonical-bootstrap-ws-"));
setRuntimeConfig(configSchema.parse({ workspace: WORKSPACE }));
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }));

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
  stopRecoveryJanitor();
});

describe("bootstrapCanonicalLoop", () => {
  it("registers the AnthropicAdapter for every lane", async () => {
    bootstrapCanonicalLoop();
    expect(isRecoveryJanitorStarted()).toBe(true);
    for (const lane of ["interactive", "build", "ide", "background"] as const) {
      const factory = resolveAdapterFactory(mkOp(lane));
      expect(factory, lane).not.toBeNull();
      const adapter = await factory!();
      expect(adapter.name).toBe(ANTHROPIC_ADAPTER_NAME);
    }
  });
});
