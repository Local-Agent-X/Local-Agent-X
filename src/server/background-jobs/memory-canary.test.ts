import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAriRequired } from "../../ari-kernel/state.js";
import { clearSessionProfile, setSessionProfile } from "../../autonomy/profile-store.js";
import { _clearDedupCacheForTests } from "../../tool-execution/dedup-cache.js";
import { MemoryIndex } from "../../memory/index.js";
import { createFactsTools } from "../../memory/tools/facts.js";
import type { ToolDefinition } from "../../types.js";
import { getMemoryCanaryStatus, makeRunMemoryCanary, MEMORY_CANARY_SESSION } from "./memory-canary.js";

let dir: string;
let memory: MemoryIndex;

beforeAll(() => setAriRequired(false));
afterAll(() => setAriRequired(true));

beforeEach(() => {
  _clearDedupCacheForTests();
  dir = mkdtempSync(join(tmpdir(), "memory-canary-"));
  memory = new MemoryIndex(dir, { minScore: -1 });
  setSessionProfile(MEMORY_CANARY_SESSION, "Power");
});

afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
  clearSessionProfile(MEMORY_CANARY_SESSION);
});

function canaryWith(tools: ToolDefinition[], broadcasts: Record<string, unknown>[]) {
  return makeRunMemoryCanary({
    security: undefined as never,
    toolPolicy: undefined as never,
    allAgentTools: tools,
    broadcast: (event) => broadcasts.push(event),
  });
}

describe("memory-write canary", () => {
  it("reports failing (and broadcasts) when the write path is broken, then recovers", async () => {
    const realTools = createFactsTools(memory) as unknown as ToolDefinition[];
    const brokenTools = realTools.map((tool) =>
      tool.name === "remember"
        ? { ...tool, execute: async () => ({ content: "BLOCKED: simulated pipeline breakage", isError: true }) }
        : tool,
    );
    const broadcasts: Record<string, unknown>[] = [];

    await canaryWith(brokenTools, broadcasts)();
    let status = getMemoryCanaryStatus();
    expect(status.state).toBe("failing");
    expect(status.failure).toMatch(/simulated pipeline breakage/);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ type: "system_health", subsystem: "memory-writes", state: "failing" });

    await canaryWith(realTools, broadcasts)();
    status = getMemoryCanaryStatus();
    expect(status.state, status.failure).toBe("ok");
    expect(status.consecutiveFailures).toBe(0);
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]).toMatchObject({ type: "system_health", subsystem: "memory-writes", state: "ok" });
    // Round trip cleaned up after itself — no canary fact left behind.
    expect(memory.recallByKind("observation")).toHaveLength(0);
  });

  it("healthy runs stay silent (no broadcast spam)", async () => {
    const broadcasts: Record<string, unknown>[] = [];
    const run = canaryWith(createFactsTools(memory) as unknown as ToolDefinition[], broadcasts);
    await run();
    await run();
    expect(getMemoryCanaryStatus().state).toBe("ok");
    expect(broadcasts).toHaveLength(0);
  });
});
