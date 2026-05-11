/**
 * Failure-recovery state tests — verify halt history accumulates across
 * "invocations" and that 3 consecutive same-gate halts trigger the
 * systemic-issue escalation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHalt,
  readBuildState,
  checkSystemic,
  statePath,
  STATE_FILENAME,
} from "../src/primal-auto-build/failure-recovery.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "primal-recovery-test-")); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("readBuildState", () => {
  it("returns empty history when no state file exists", () => {
    expect(readBuildState(dir)).toEqual({ haltHistory: [] });
  });

  it("returns empty history on a malformed file", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(statePath(dir), "{not valid json");
    expect(readBuildState(dir)).toEqual({ haltHistory: [] });
  });
});

describe("appendHalt", () => {
  it("creates the state file on first halt", () => {
    appendHalt(dir, { chunk: 5, gate: "additive-diff", reason: "weakened constraint" });
    expect(existsSync(statePath(dir))).toBe(true);
    const state = readBuildState(dir);
    expect(state.haltHistory).toHaveLength(1);
    expect(state.haltHistory[0].chunk).toBe(5);
    expect(state.haltHistory[0].gate).toBe("additive-diff");
  });

  it("appends subsequent halts to the existing history", () => {
    appendHalt(dir, { chunk: 5, gate: "additive-diff", reason: "first" });
    appendHalt(dir, { chunk: 6, gate: "additive-diff", reason: "second" });
    const state = readBuildState(dir);
    expect(state.haltHistory).toHaveLength(2);
    expect(state.haltHistory[1].chunk).toBe(6);
  });

  it("caps history at 10 entries", () => {
    for (let i = 1; i <= 15; i++) {
      appendHalt(dir, { chunk: i, gate: "g", reason: `r${i}` });
    }
    const state = readBuildState(dir);
    expect(state.haltHistory).toHaveLength(10);
    expect(state.haltHistory[0].chunk).toBe(6); // oldest in the trailing 10
    expect(state.haltHistory[9].chunk).toBe(15);
  });
});

describe("checkSystemic", () => {
  it("returns systemic:false when history is short", () => {
    expect(checkSystemic({ haltHistory: [] }).systemic).toBe(false);
    appendHalt(dir, { chunk: 1, gate: "done-when", reason: "x" });
    expect(checkSystemic(readBuildState(dir)).systemic).toBe(false);
  });

  it("returns systemic:true after 3 consecutive same-gate halts", () => {
    appendHalt(dir, { chunk: 1, gate: "additive-diff", reason: "a" });
    appendHalt(dir, { chunk: 2, gate: "additive-diff", reason: "b" });
    appendHalt(dir, { chunk: 3, gate: "additive-diff", reason: "c" });
    const result = checkSystemic(readBuildState(dir));
    expect(result.systemic).toBe(true);
    expect(result.gate).toBe("additive-diff");
    expect(result.count).toBe(3);
    expect(result.advice).toContain("additive-diff");
  });

  it("does NOT trigger when the 3-halt tail spans multiple gates", () => {
    appendHalt(dir, { chunk: 1, gate: "additive-diff", reason: "a" });
    appendHalt(dir, { chunk: 2, gate: "done-when", reason: "b" });
    appendHalt(dir, { chunk: 3, gate: "additive-diff", reason: "c" });
    expect(checkSystemic(readBuildState(dir)).systemic).toBe(false);
  });

  it("ignores empty-gate halts (infrastructure failures)", () => {
    appendHalt(dir, { chunk: 1, gate: "", reason: "git failed" });
    appendHalt(dir, { chunk: 2, gate: "", reason: "git failed" });
    appendHalt(dir, { chunk: 3, gate: "", reason: "git failed" });
    expect(checkSystemic(readBuildState(dir)).systemic).toBe(false);
  });

  it("clears on a different-gate halt after a streak", () => {
    appendHalt(dir, { chunk: 1, gate: "additive-diff", reason: "a" });
    appendHalt(dir, { chunk: 2, gate: "additive-diff", reason: "b" });
    appendHalt(dir, { chunk: 3, gate: "done-when", reason: "c" });
    expect(checkSystemic(readBuildState(dir)).systemic).toBe(false);
  });
});

describe("state file is named the expected filename", () => {
  it("uses .primal-build-state.json in project_dir", () => {
    expect(STATE_FILENAME).toBe(".primal-build-state.json");
    expect(statePath(dir).endsWith(STATE_FILENAME)).toBe(true);
  });
});
