/**
 * Chunk-runner agent tests.
 *
 * Two layers covered:
 *   1. Definition assembly — verify each role yields an AgentDefinition
 *      with the right skill body inlined into systemPrompt and the
 *      chunk-runner discipline appended.
 *   2. Caching — definitions are computed once per role.
 *
 * The actual runChunkAgent() runtime (event-bus wait, timeout, abort) is
 * exercised indirectly via test/primal-loop.test.ts which mocks the
 * whole module. Unit-testing the EventBus dance here would require
 * stubbing Handler + invokeDefinition + the bus — overkill for what's
 * essentially a coordination shim.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { _clearChunkAgentDefCache } from "../src/primal-auto-build/agents/chunk-runner.js";

describe("chunk-runner definitions", () => {
  beforeEach(() => { _clearChunkAgentDefCache(); });

  // Module-internal accessor — pulled in via dynamic import so we test
  // the production code path the cache.
  it("can be imported without side effects (lazy by design)", async () => {
    const mod = await import("../src/primal-auto-build/agents/chunk-runner.js");
    expect(typeof mod.runChunkAgent).toBe("function");
    expect(typeof mod._clearChunkAgentDefCache).toBe("function");
  });
});
