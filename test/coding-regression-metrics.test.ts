// The coding regression set reads each run's steps, calls, refusals and guard
// firings from the isolated server's op store, for that run's session only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs eval module
import { formatMetrics, runMetrics } from "../eval/grok-coding-parity/run-metrics.mjs";

function seedOp(dataDir: string, id: string, sessionId: string, turns: unknown[][], events: string[] = []) {
  const dir = join(dataDir, "operations", id);
  mkdirSync(join(dir, "op-turns"), { recursive: true });
  writeFileSync(join(dir, "operation.json"), JSON.stringify({ id, sessionId }));
  turns.forEach((messages, i) => writeFileSync(join(dir, "op-turns", `${i}.json`), JSON.stringify({ turn: { turnIdx: i }, messages })));
  writeFileSync(join(dir, "canonical-events.jsonl"), events.join("\n"));
}

const call = (id: string) => ({ role: "assistant", content: { text: "", toolCalls: [{ id, name: "bash", arguments: "{}" }] } });
const result = (id: string, head: string) => ({ role: "tool_result", content: { toolCallId: id, result: `${head} …` } });
const fired = (name: string) => JSON.stringify({ type: "middleware_fired", body: { name, turnIdx: 1 } });

describe("runMetrics", () => {
  it("counts this session's steps, calls, refusals, failures and guards, and nothing else", () => {
    const data = mkdtempSync(join(tmpdir(), "lax-regression-"));
    seedOp(data, "op_a", "parity-x", [
      [call("c1"), result("c1", "[ok]")],
      [call("c2"), result("c2", "[blocked]"), call("c3"), result("c3", "[error]")],
    ], [fired("budget-ladder"), fired("budget-ladder"), fired("verify-gate"), "{torn"]);
    seedOp(data, "op_b", "someone-else", [[call("z"), result("z", "[blocked]")]]);
    const m = runMetrics(data, "parity-x");
    expect(m).toEqual({ ops: 1, steps: 2, toolCalls: 3, blocked: 1, failed: 1, guards: { "budget-ladder": 2, "verify-gate": 1 } });
    expect(formatMetrics(m)).toBe("2 steps, 3 calls, 1 blocked, 1 failed, guards: budget-ladder×2, verify-gate×1");
  });

  it("reports nothing for a live target (no data dir) or an unknown session", () => {
    expect(runMetrics(undefined, "s")).toMatchObject({ ops: 0, steps: 0 });
    expect(runMetrics(mkdtempSync(join(tmpdir(), "lax-regression-")), "s")).toMatchObject({ ops: 0 });
  });
});
