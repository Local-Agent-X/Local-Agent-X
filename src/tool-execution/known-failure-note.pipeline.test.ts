// The whole seam, through the real dispatch pipeline: a call fails → the usage
// log says which failure it was → a lesson for that signature is proposed,
// then kept → the same failure in another run comes back with the lesson
// leading its result → the same work then succeeding is counted → a discarded
// lesson is silent again. Each half is unit-tested where it lives; this is the
// test that fails if the record and the lookup ever stop agreeing on what
// "the same failure" is.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatchOne } from "./dispatch-one.test-helper.js";
import { _clearDedupCacheForTests } from "./dedup-cache.js";
import { _resetKnownFailureNotes } from "./known-failure-note.js";
import { readToolFailures } from "./tool-usage-telemetry.js";
import { setAriRequired } from "../ari-kernel/state.js";
import {
  decideLesson, listKnownFailures, recordFailureReview,
} from "../cognition/cross-session-learning/known-failures.js";
import { clusterToolFailures } from "../cognition/cross-session-learning/failure-patterns.js";
import type { ToolDefinition, ToolResult } from "../types.js";

const LESSON = "python3 is not on PATH on this computer; python runs the same interpreter.";
const FAILED: ToolResult = { content: "python3: command not found", isError: true, status: "error" };
const WORKED: ToolResult = { content: "report written" };

let next: ToolResult = FAILED;
const runner: ToolDefinition = {
  name: "run_stub",
  description: "",
  parameters: { type: "object", properties: { n: { type: "number" } } },
  readOnly: true,
  concurrencySafe: true,
  execute: async (): Promise<ToolResult> => next,
} as unknown as ToolDefinition;
const toolMap = new Map<string, ToolDefinition>([["run_stub", runner]]);

let callSeq = 0;
/** One call of the stub in `run` of `chat`, answered with `result`. */
async function call(result: ToolResult, chat: string, run: string): Promise<ToolResult> {
  next = result;
  const n = callSeq++;
  return dispatchOne(
    { id: `call-${n}`, name: "run_stub", args: { n } },
    { toolMap, security: undefined as never, callContext: "api", sessionId: chat, operationId: run },
  );
}

describe("a kept lesson reaches the next run that hits the same failure", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));
  beforeEach(() => { _clearDedupCacheForTests(); _resetKnownFailureNotes(); });

  it("records the failure, stays silent until the lesson is kept, then leads the result with it", async () => {
    // Three chats hit it. Nothing is known yet, so nothing is said.
    for (const chat of ["chat-a", "chat-b", "chat-c"]) {
      const failed = await call(FAILED, chat, `op-${chat}`);
      expect(failed.status).toBe("error");
      expect(failed.content).not.toContain("[Seen before]");
    }
    const logged = await readToolFailures(0);
    expect(logged.map((e) => e.sessionId)).toEqual(["chat-a", "chat-b", "chat-c"]);
    const [pattern] = clusterToolFailures(logged, Date.now());
    expect(pattern).toMatchObject({ tool: "run_stub", status: "error", reason: "python3: command not found", sessions: 3, count: 3 });
    // A sample points back at the run and the call, for the review to open.
    expect(pattern.samples[0]).toMatchObject({ opId: "op-chat-c", sessionId: "chat-c" });

    // The review writes a lesson. Proposed is not delivered.
    recordFailureReview(pattern, { verdict: "lesson", lesson: LESSON, why: "the retry with python worked" }, Date.now());
    expect((await call(FAILED, "chat-d", "op-d")).content).not.toContain("[Seen before]");

    // The user keeps it. The same failure in a new run now comes back with it.
    decideLesson(pattern.signature, "keep");
    const noted = await call(FAILED, "chat-e", "op-e");
    expect(noted.status).toBe("error");
    expect(noted.content).toContain("[Seen before] This call has failed this way in 3 earlier chats on this computer.");
    expect(noted.content).toContain(LESSON);
    // The note leads; the tool's own output is still there, after it.
    expect(noted.content.indexOf("[Seen before]")).toBeLessThan(noted.content.indexOf("python3: command not found"));
    expect(noted.content.indexOf(LESSON)).toBeLessThan(noted.content.lastIndexOf("python3: command not found"));

    // Once per run for the same work, and the retry working counts as the lesson helping.
    expect((await call(FAILED, "chat-e", "op-e")).content).not.toContain("[Seen before]");
    expect((await call(WORKED, "chat-e", "op-e")).content).toContain("report written");
    expect(listKnownFailures()[0]).toMatchObject({ state: "kept", shown: 1, recovered: 1 });

    // Discarded: silent again.
    decideLesson(pattern.signature, "discard");
    expect((await call(FAILED, "chat-f", "op-f")).content).not.toContain("[Seen before]");
  });

  it("does not put a lesson on a different failure of the same tool", async () => {
    const known = listKnownFailures()[0];
    decideLesson(known.signature, "keep");
    const other = await call({ content: "permission denied: report.txt", isError: true, status: "error" }, "chat-g", "op-g");
    expect(other.content).not.toContain("[Seen before]");
  });
});
