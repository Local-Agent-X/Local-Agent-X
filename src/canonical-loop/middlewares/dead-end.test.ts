/**
 * Behavior tests for the dead-end middleware: 3 empty tool results in a row
 * → "stop, pick a different tool" nudge. Runs on ALL lanes (no when-gate —
 * deliberately, see dead-end.ts + worker-op-gate.test.ts's comment), so the
 * cases here drive the interactive lane where the grok `ls` spin lived.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { deadEndMiddleware } from "./dead-end.js";
import { _resetMiddlewareStates } from "./state.js";
import type { CanonicalLoopContext, CanonicalToolResultView } from "./types.js";

let _op = 0;
const opId = () => `op-de-test-${++_op}`;

function result(content: string, toolName = "grep"): CanonicalToolResultView {
  return { toolName, toolCallId: "c1", content, status: "ok" };
}

function ctxFor(op: string, lane: string, toolResults: CanonicalToolResultView[]): CanonicalLoopContext {
  return {
    op: { id: op, lane },
    toolCalls: [],
    toolResults,
  } as unknown as CanonicalLoopContext;
}

const turn = (op: string, lane: string, ...results: CanonicalToolResultView[]) =>
  deadEndMiddleware.afterToolExecution!(ctxFor(op, lane, results));

beforeEach(() => _resetMiddlewareStates());

describe("dead-end middleware", () => {
  it("nudges after 3 consecutive empty results across turns (interactive lane)", async () => {
    const op = opId();
    expect((await turn(op, "interactive", result("No matches found"))).kind).toBe("continue");
    expect((await turn(op, "interactive", result("(no output)", "bash"))).kind).toBe("continue");
    const r = await turn(op, "interactive", result("Searched 120 files, 0 results"));
    expect(r).toMatchObject({ kind: "nudge", reason: "dead-end" });
    if (r.kind === "nudge") {
      expect(r.message).toMatch(/DIFFERENT tool/);
      expect(r.message).toContain("grep"); // names the spinning tool
    }
  });

  it("counts a single batched turn's empty results toward the strike total", async () => {
    const op = opId();
    const r = await turn(
      op, "agent",
      result("No results"), result("No matches"), result("(no output)"),
    );
    expect(r).toMatchObject({ kind: "nudge", reason: "dead-end" });
  });

  it("a productive result in between resets the strike counter", async () => {
    const op = opId();
    await turn(op, "agent", result("No matches found"));
    await turn(op, "agent", result("No matches found"));
    await turn(op, "agent", result("src/parser.ts:41: tokenize()"));
    await turn(op, "agent", result("No matches found"));
    expect((await turn(op, "agent", result("No matches found"))).kind).toBe("continue");
  });

  it("resets after firing so the same nudge doesn't spam every turn", async () => {
    const op = opId();
    await turn(op, "agent", result("No results"));
    await turn(op, "agent", result("No results"));
    expect((await turn(op, "agent", result("No results"))).kind).toBe("nudge");
    // Strike count restarted — the very next empty result doesn't re-fire.
    expect((await turn(op, "agent", result("No results"))).kind).toBe("continue");
  });

  it("keeps per-op state independent — one op's strikes don't leak into another", async () => {
    const a = opId();
    const b = opId();
    await turn(a, "agent", result("No results"));
    await turn(a, "agent", result("No results"));
    expect((await turn(b, "agent", result("No results"))).kind).toBe("continue");
  });
});
