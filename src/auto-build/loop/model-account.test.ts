// A worker whose model account refused the request stops the build once, with
// what to fix (model-account.ts; Shop Helper's Grok credits, 2026-11-27).
import { describe, expect, it } from "vitest";
import { modelAccountProblem, modelAccountStop } from "./model-account.js";
import { chunkProcessFailureOutcome } from "./run-chunk-once.js";

const OUT_OF_CREDITS = '[Agent did not finish: the run failed: transport_error: 402 "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/"]';

describe("a model account that cannot run a worker", () => {
  it("is told apart from a worker that crashed or timed out", () => {
    expect(modelAccountProblem(OUT_OF_CREDITS)).toContain("is out of credits or has no active plan");
    expect(modelAccountProblem("401 Unauthorized: invalid api key")).toContain("is not signed in");
    expect(modelAccountProblem("agent threw: cannot read properties of undefined")).toBeNull();
    expect(modelAccountProblem("timed out after 900s")).toBeNull();
    expect(modelAccountProblem(undefined)).toBeNull();
  });

  it("halts the chunk with what to fix, where a crash would be retried", () => {
    const blocked = chunkProcessFailureOutcome(2, { exitCode: 1, durationMs: 900, error: OUT_OF_CREDITS }, false)!;
    expect(blocked.action).toBe("halt");
    expect(blocked.findings[0]).toMatchObject({ gate: "model-account", action: "halt" });
    expect(modelAccountStop(blocked)).toContain("Fix the account, then Resume");
    expect(modelAccountStop(blocked)).toContain("You have run out of credits");
    const crashed = chunkProcessFailureOutcome(2, { exitCode: 1, durationMs: 900, error: "agent threw" }, false)!;
    expect(crashed.action).toBe("push_back");
    expect(modelAccountStop(crashed)).toBeNull();
  });

  it("an owner's stop is a stop, whatever the worker's last error said", () => {
    expect(chunkProcessFailureOutcome(2, { exitCode: 130, durationMs: 900, error: OUT_OF_CREDITS }, true)!.findings[0].gate).toBe("worker-run");
  });
});
