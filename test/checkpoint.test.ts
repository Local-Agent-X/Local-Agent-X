import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { newCheckpoint, readCheckpoint, writeCheckpoint } from "../src/workers/checkpoint.js";
import { opDir } from "../src/workers/event-log.js";
import type { OpCheckpoint } from "../src/workers/types.js";

let counter = 0;
const opId = (tag: string): string => `op-ckpt-test-${tag}-${Date.now()}-${counter++}`;

const created: string[] = [];
const trackedOpId = (tag: string): string => {
  const id = opId(tag);
  created.push(id);
  return id;
};

afterAll(() => {
  const base = join(homedir(), ".lax", "operations");
  for (const id of created) {
    const dir = join(base, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
});

describe("newCheckpoint", () => {
  it("returns a fresh checkpoint with the given opId and providerUsed", () => {
    const c = newCheckpoint("op-x", "anthropic");
    expect(c.opId).toBe("op-x");
    expect(c.providerUsed).toBe("anthropic");
  });

  it("initializes plan/changedFiles/pendingInstructions to empty arrays", () => {
    const c = newCheckpoint("op-x", "openai");
    expect(c.plan).toEqual([]);
    expect(c.changedFiles).toEqual([]);
    expect(c.pendingInstructions).toEqual([]);
  });

  it("initializes counters to zero and worktree/commit to null", () => {
    const c = newCheckpoint("op-x", "openai");
    expect(c.completedSteps).toBe(0);
    expect(c.retryCount).toBe(0);
    expect(c.worktreeBranch).toBeNull();
    expect(c.lastCommitSha).toBeNull();
  });

  it("sets updatedAt to a valid ISO timestamp", () => {
    const before = Date.now();
    const c = newCheckpoint("op-x", "openai");
    const after = Date.now();
    const t = new Date(c.updatedAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after + 5);
  });

  it("sets lastSafeBoundary.label to 'op-started'", () => {
    const c = newCheckpoint("op-x", "openai");
    expect(c.lastSafeBoundary.label).toBe("op-started");
    expect(typeof c.lastSafeBoundary.timestamp).toBe("string");
  });
});

describe("writeCheckpoint + readCheckpoint — round-trip", () => {
  it("writes a checkpoint to disk and reads it back identically", () => {
    const id = trackedOpId("rt");
    const c = newCheckpoint(id, "anthropic");
    c.completedSteps = 3;
    c.changedFiles = ["src/a.ts", "src/b.ts"];
    writeCheckpoint(c);
    const back = readCheckpoint(id);
    expect(back).not.toBeNull();
    expect(back!.opId).toBe(id);
    expect(back!.completedSteps).toBe(3);
    expect(back!.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("overwrites the prior checkpoint on a second write", () => {
    const id = trackedOpId("overwrite");
    const c1 = newCheckpoint(id, "anthropic");
    c1.completedSteps = 1;
    writeCheckpoint(c1);
    const c2 = newCheckpoint(id, "anthropic");
    c2.completedSteps = 5;
    writeCheckpoint(c2);
    const back = readCheckpoint(id);
    expect(back!.completedSteps).toBe(5);
  });

  it("write is atomic — no leftover .tmp file after a successful write", () => {
    const id = trackedOpId("atomic");
    const c = newCheckpoint(id, "openai");
    writeCheckpoint(c);
    const tmp = join(opDir(id), "checkpoint.json.tmp");
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(join(opDir(id), "checkpoint.json"))).toBe(true);
  });

  it("on-disk representation is pretty-printed (2-space indent)", () => {
    const id = trackedOpId("pretty");
    const c = newCheckpoint(id, "openai");
    writeCheckpoint(c);
    const raw = readFileSync(join(opDir(id), "checkpoint.json"), "utf-8");
    expect(raw).toContain("\n  ");
    expect(raw).toContain("\"opId\": ");
  });
});

describe("readCheckpoint — robustness", () => {
  it("returns null when no checkpoint exists", () => {
    const id = trackedOpId("missing");
    expect(readCheckpoint(id)).toBeNull();
  });

  it("returns null when the file contains invalid JSON", () => {
    const id = trackedOpId("malformed");
    const path = join(opDir(id), "checkpoint.json");
    writeFileSync(path, "{not-valid-json", "utf-8");
    expect(readCheckpoint(id)).toBeNull();
  });

  it("returns the parsed checkpoint even if some fields are missing (best-effort)", () => {
    const id = trackedOpId("partial");
    const path = join(opDir(id), "checkpoint.json");
    writeFileSync(path, JSON.stringify({ opId: id, plan: [] }), "utf-8");
    const back = readCheckpoint(id);
    expect(back).not.toBeNull();
    expect(back!.opId).toBe(id);
  });
});

describe("writeCheckpoint — never throws on disk error", () => {
  it("write of a valid checkpoint with a plan array survives JSON-encoding edge cases", () => {
    const id = trackedOpId("plan");
    const c: OpCheckpoint = {
      ...newCheckpoint(id, "openai"),
      plan: [
        { index: 0, description: "step 0", status: "completed" },
        { index: 1, description: "step 1 with \"quotes\" and \\backslash", status: "running" },
      ],
    };
    expect(() => writeCheckpoint(c)).not.toThrow();
    const back = readCheckpoint(id);
    expect(back!.plan).toHaveLength(2);
    expect(back!.plan[1].description).toContain("\"quotes\"");
  });
});
