import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeInitial,
  settleChunk,
  statePath,
  write,
} from "./state.js";
import type { ParsedChunk } from "../plan-parser.js";

describe("orchestrator state durability", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "orchestrator-state-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns false and removes its temp file when the atomic rename fails", () => {
    mkdirSync(statePath(projectDir));
    const state = makeInitial({
      opId: "op_state_failure",
      sessionId: "state-session",
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      totalChunks: 1,
      startingChunk: 1,
    });

    expect(write(state)).toBe(false);
    expect(readdirSync(projectDir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});

// Killed between a chunk's landing and the loop's later callback, the state
// still named the landed chunk as part-built, and the next start moved its
// commit off the project to "keep" it (review of the pause work, 2026-11-25).
describe("settleChunk", () => {
  const base = makeInitial({ opId: "op_s", sessionId: "s", projectDir: "C:/p", planPath: "C:/p/spec/plan.md", totalChunks: 3, startingChunk: 1 });
  const inTree = (chunk: number) => ({ chunk, title: "t", preSha: "abc", round: 2, findings: [] });
  const fix = (n: number) => ({ number: n } as ParsedChunk);

  it("drops the part-built note for the chunk that settled, and no other", () => {
    expect(settleChunk({ ...base, inTreeChunk: inTree(2) }, 2).inTreeChunk).toBeUndefined();
    expect(settleChunk({ ...base, inTreeChunk: inTree(2) }, 3).inTreeChunk).toEqual(inTree(2));
  });

  it("marks a finish fix of the round done, once", () => {
    const finish = { round: 1, fixRounds: 2, runBase: 0, fixes: [fix(1011), fix(1012)], done: [] as number[], open: [] };
    const settled = settleChunk({ ...base, finish, inTreeChunk: inTree(1011) }, 1011);
    expect(settled.finish?.done).toEqual([1011]);
    expect(settled.inTreeChunk).toBeUndefined();
    expect(settleChunk(settled, 1011)).toBe(settled);
    expect(settleChunk(settled, 7)).toBe(settled);
  });
});

