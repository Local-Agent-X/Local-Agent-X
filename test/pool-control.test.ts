import { describe, it, expect } from "vitest";
import { killOp, redirectOp } from "../src/workers/pool.js";

// killOp / redirectOp look up the op's worker slot and forward an IPC
// message. When the slot map is empty (no workers spawned in the test env,
// or the opId genuinely matches no in-flight slot) both must return false
// without throwing — the chat agent uses the boolean to choose between
// "killed" and "couldn't find that op" wording.
//
// This test deliberately doesn't call submitOp/startWorkerPool so no
// subprocesses spawn. The pool's slots[] is empty, which is exactly the
// "no matching worker" branch we want to exercise.

describe("killOp — no matching worker", () => {
  it("returns false for an opId that no slot is busy with", () => {
    expect(killOp("op-that-does-not-exist")).toBe(false);
  });

  it("returns false for an empty opId", () => {
    expect(killOp("")).toBe(false);
  });

  it("does not throw on a malformed-looking opId", () => {
    expect(() => killOp("../weird/../path")).not.toThrow();
    expect(killOp("../weird/../path")).toBe(false);
  });

  it("repeated calls keep returning false (no internal state mutation)", () => {
    expect(killOp("op-x")).toBe(false);
    expect(killOp("op-x")).toBe(false);
    expect(killOp("op-x")).toBe(false);
  });
});

describe("redirectOp — no matching worker", () => {
  it("returns false for an opId that no slot is busy with", () => {
    expect(redirectOp("op-not-here", "do something else")).toBe(false);
  });

  it("returns false even when instruction is empty", () => {
    expect(redirectOp("op-x", "")).toBe(false);
  });

  it("does not throw on multi-line instructions", () => {
    expect(() => redirectOp("op-x", "line1\nline2\nline3")).not.toThrow();
    expect(redirectOp("op-x", "line1\nline2\nline3")).toBe(false);
  });

  it("does not throw on instructions with unicode + quotes", () => {
    const tricky = `update "the readme" with — em-dash and 中文 ✓`;
    expect(() => redirectOp("op-x", tricky)).not.toThrow();
    expect(redirectOp("op-x", tricky)).toBe(false);
  });
});
