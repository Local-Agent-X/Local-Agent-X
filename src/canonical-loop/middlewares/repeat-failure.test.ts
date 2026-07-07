import { describe, it, expect } from "vitest";
import { repeatFailureMiddleware } from "./repeat-failure.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-rf-test-${++_op}`; }

function ctxFor(
  op: string,
  results: Array<{ toolName: string; content: string; status: "ok" | "error" | "blocked" | "declined" | "timeout" | "cancelled" }>,
): CanonicalLoopContext {
  return {
    op: { id: op },
    toolResults: results.map((r) => ({ ...r, toolCallId: "tc" })),
  } as unknown as CanonicalLoopContext;
}

const fail = (content = "Failed to edit presentation: Could not read deck.pptx") =>
  ({ toolName: "presentation_edit", content, status: "error" as const });
const ok = () => ({ toolName: "presentation_edit", content: "Edited deck.pptx", status: "ok" as const });

async function run(op: string, results: Parameters<typeof ctxFor>[1]) {
  return repeatFailureMiddleware.afterToolExecution!(ctxFor(op, results));
}

describe("repeat-failure breaker", () => {
  it("nudges at 3 consecutive same-tool same-error failures across turns", async () => {
    const op = opId();
    expect((await run(op, [fail()])).kind).toBe("continue");
    expect((await run(op, [fail()])).kind).toBe("continue");
    const r3 = await run(op, [fail()]);
    expect(r3.kind).toBe("nudge");
    expect((r3 as { message: string }).message).toContain("3 times in a row");
  });

  it("aborts at 5 consecutive identical failures", async () => {
    const op = opId();
    for (let i = 0; i < 4; i++) await run(op, [fail()]);
    const r5 = await run(op, [fail()]);
    expect(r5.kind).toBe("abort");
  });

  it("a success resets the streak", async () => {
    const op = opId();
    await run(op, [fail()]);
    await run(op, [fail()]);
    expect((await run(op, [ok()])).kind).toBe("continue");
    // Two more failures: streak restarts at 1, no nudge yet.
    await run(op, [fail()]);
    expect((await run(op, [fail()])).kind).toBe("continue");
  });

  it("a DIFFERENT error restarts the count (progressing retries aren't punished)", async () => {
    const op = opId();
    await run(op, [fail("error A")]);
    await run(op, [fail("error A")]);
    expect((await run(op, [fail("error B — different cause")])).kind).toBe("continue");
  });

  it("counts failures within a single multi-call turn", async () => {
    const op = opId();
    const r = await run(op, [fail(), fail(), fail()]);
    expect(r.kind).toBe("nudge");
  });

  // Regression (dispatch-status widening): blocked/declined/timeout used to
  // arrive collapsed as "error". Now that the flavor survives the boundary,
  // they must STILL count toward the streak — on pre-fix code they reset it.
  it("widened failure flavors (blocked) count toward the streak", async () => {
    const op = opId();
    const b = { toolName: "bash", content: "Refused by policy.", status: "blocked" as const };
    expect((await run(op, [b])).kind).toBe("continue");
    expect((await run(op, [b])).kind).toBe("continue");
    expect((await run(op, [b])).kind).toBe("nudge");
  });

  it("a cancelled result resets the streak (not a failure)", async () => {
    const op = opId();
    await run(op, [fail()]);
    await run(op, [fail()]);
    await run(op, [{ toolName: "presentation_edit", content: "cancelled", status: "cancelled" as const }]);
    expect((await run(op, [fail()])).kind).toBe("continue"); // restarted at 1
  });
});
