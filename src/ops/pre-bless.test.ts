import { describe, it, expect } from "vitest";
import { collectPreBlessedSecrets } from "./pre-bless.js";
import type { Op, OpStatus } from "./types.js";

function op(status: OpStatus, preBlessed?: string[]): Op {
  return {
    id: "op_test",
    type: "freeform",
    task: "t",
    contextPack: {
      task: { description: "", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 0, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "build" },
      secrets: { allowed: [], ...(preBlessed ? { preBlessed } : {}) },
    },
    lane: "build",
    retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
    ownerId: "u",
    visibility: "private",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 0,
  };
}

describe("collectPreBlessedSecrets — liveness-scoped union", () => {
  it("unions preBlessed names across RUNNING ops", () => {
    const ops = [op("running", ["GH_TOKEN", "NPM_TOKEN"]), op("running", ["NPM_TOKEN", "AWS_KEY"])];
    expect(collectPreBlessedSecrets(ops)).toEqual(new Set(["GH_TOKEN", "NPM_TOKEN", "AWS_KEY"]));
  });

  it("excludes every non-running status (the bless is live only WHILE the op runs)", () => {
    const dead: OpStatus[] = ["pending", "paused", "completed", "failed", "cancelled", "needs-input", "merge-conflict-pending"];
    for (const s of dead) {
      expect(collectPreBlessedSecrets([op(s, ["SECRET"])])).toEqual(new Set());
    }
  });

  it("is null-safe for a running op with no preBlessed list", () => {
    expect(collectPreBlessedSecrets([op("running")])).toEqual(new Set());
  });

  it("returns empty for no ops (no auto-approval by default)", () => {
    expect(collectPreBlessedSecrets([])).toEqual(new Set());
  });

  it("a finished op never blesses, even if a sibling running op blesses something else", () => {
    expect(collectPreBlessedSecrets([op("completed", ["GONE"]), op("running", ["LIVE"])]))
      .toEqual(new Set(["LIVE"]));
  });
});
