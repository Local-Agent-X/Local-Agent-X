import { describe, it, expect } from "vitest";
import { repeatFailureMiddleware } from "./repeat-failure.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-rf-test-${++_op}`; }

function ctxFor(
  op: string,
  results: Array<{ toolName: string; content: string; status: "ok" | "error" | "blocked" | "declined" | "timeout" | "cancelled" }>,
  lane: "interactive" | "build" = "build",
): CanonicalLoopContext {
  return {
    op: { id: op, lane },
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
    expect((r3 as { message: string }).message).toContain("unresolved failure 3 times");
  });

  it("suspends an autonomous worker at 5 unresolved identical failures", async () => {
    const op = opId();
    for (let i = 0; i < 4; i++) await run(op, [fail()]);
    const r5 = await run(op, [fail()]);
    expect(r5.kind).toBe("suspend");
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

  it("an unrelated successful read does not hide an unresolved shell block", async () => {
    const op = opId();
    const blocked = {
      toolName: "bash",
      content: "[blocked, layer=\"sandbox\"] BLOCKED (unattended): bash cannot execute",
      status: "blocked" as const,
    };
    for (let i = 0; i < 4; i++) {
      await run(op, [blocked]);
      await run(op, [{ toolName: "read", content: "file contents", status: "ok" }]);
    }
    expect((await run(op, [blocked])).kind).toBe("suspend");
  });

  it("groups shell-backed tools under one unresolved capability failure", async () => {
    const op = opId();
    const names = ["bash", "app_serve_frontend", "process_start", "bash", "app_serve_frontend"];
    let result: Awaited<ReturnType<typeof run>> | undefined;
    for (const toolName of names) {
      result = await run(op, [{
        toolName,
        content: `[blocked, layer=\"sandbox\"] BLOCKED (unattended): ${toolName} cannot execute`,
        status: "blocked",
      }]);
    }
    expect(result?.kind).toBe("suspend");
  });

  it("keeps abort semantics for interactive turns", async () => {
    const op = opId();
    for (let i = 0; i < 4; i++) await run(op, [fail()]);
    const r5 = await repeatFailureMiddleware.afterToolExecution!(ctxFor(op, [fail()], "interactive"));
    expect(r5.kind).toBe("abort");
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
