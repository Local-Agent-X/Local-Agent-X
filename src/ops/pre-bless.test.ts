import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPreBlessedSecrets, createPreBlessScanner } from "./pre-bless.js";
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

describe("createPreBlessScanner — the op-store scan behind every vault destination check", () => {
  let dir: string;
  let reads: string[];
  let scan: () => Set<string>;
  const write = (id: string, record: Op, mtimeSec: number) => {
    mkdirSync(join(dir, id), { recursive: true });
    const file = join(dir, id, "operation.json");
    writeFileSync(file, JSON.stringify(record));
    utimesSync(file, mtimeSec, mtimeSec);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pre-bless-"));
    reads = [];
    scan = createPreBlessScanner(dir, (id) => {
      reads.push(id);
      return JSON.parse(readFileSync(join(dir, id, "operation.json"), "utf8")) as Op;
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("blesses what running ops on disk bless", () => {
    write("op_a", op("running", ["GH_TOKEN"]), 1000);
    write("op_b", op("completed", ["OLD"]), 1000);
    expect(scan()).toEqual(new Set(["GH_TOKEN"]));
  });

  it("does not re-read an op whose operation.json is unchanged", () => {
    write("op_a", op("running", ["GH_TOKEN"]), 1000);
    write("op_b", op("completed"), 1000);
    scan();
    reads = [];
    expect(scan()).toEqual(new Set(["GH_TOKEN"]));
    expect(reads).toEqual([]);
  });

  it("sees an op another process finished: the rewrite changes the file", () => {
    write("op_a", op("running", ["GH_TOKEN"]), 1000);
    expect(scan()).toEqual(new Set(["GH_TOKEN"]));
    write("op_a", op("completed", ["GH_TOKEN"]), 2000);
    expect(scan()).toEqual(new Set());
    expect(reads).toEqual(["op_a", "op_a"]);
  });

  it("drops an op whose directory was pruned", () => {
    write("op_a", op("running", ["GH_TOKEN"]), 1000);
    scan();
    rmSync(join(dir, "op_a"), { recursive: true, force: true });
    expect(scan()).toEqual(new Set());
  });

  it("blesses nothing when the ops directory does not exist yet", () => {
    expect(createPreBlessScanner(join(dir, "missing"), () => null)()).toEqual(new Set());
  });
});
