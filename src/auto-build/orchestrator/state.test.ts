import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeInitial,
  statePath,
  write,
} from "./state.js";

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
