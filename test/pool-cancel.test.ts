import { describe, it, expect } from "vitest";
import { cancelQueuedOp } from "../src/workers/pool.js";

// Importing pool.ts is safe — startWorkerPool() is not called until submitOp.
// cancelQueuedOp is a pure manipulation of the in-memory queue + event bus,
// so an "op not in queue" call must return false without side effects.

describe("cancelQueuedOp", () => {
  it("returns false when the opId is not in the queue", () => {
    expect(cancelQueuedOp("op_does_not_exist_12345")).toBe(false);
  });

  it("is idempotent — second call on the same id still returns false", () => {
    cancelQueuedOp("op_does_not_exist_12345");
    expect(cancelQueuedOp("op_does_not_exist_12345")).toBe(false);
  });
});
