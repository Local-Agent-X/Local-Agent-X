/**
 * Thrash-guard regression tests — replays the 2026-07-20 incident shape:
 * browser failures interleaved with browserMode/enableComputerControl flips,
 * which slipped past circuit-breaker (per-args keying), repeat-failure
 * (per-error keying) and loop-detection (browser = mutation override).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { thrashGuardMiddleware } from "./thrash-guard.js";
import { _resetMiddlewareStates } from "./state.js";
import type { CanonicalLoopContext, CanonicalToolResultView } from "./types.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

let seq = 0;

function mkOp(lane: Op["lane"] = "interactive"): Op {
  return {
    id: `op_thrash_${++seq}`,
    type: "chat_turn",
    task: "thrash test",
    contextPack: { preferredProvider: "anthropic" } as unknown as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

function mkCtx(op: Op, calls: ToolCall[], results: CanonicalToolResultView[]): CanonicalLoopContext {
  return {
    op,
    turnIdx: 0,
    userMessage: "",
    provider: "xai",
    model: "grok-4.5",
    tools: [],
    toolNames: new Set(),
    assistantContent: "",
    toolCalls: calls,
    toolResults: results,
    toolsCalledThisOp: new Set(),
    committingToolsThisOp: new Set(),
    attemptedToolsThisOp: new Set(),
    evidenceHistory: [],
  };
}

function fail(tool: string, content: string): { call: ToolCall; result: CanonicalToolResultView } {
  const id = `c${++seq}`;
  return {
    call: { toolCallId: id, tool, args: {} },
    result: { toolName: tool, toolCallId: id, content, status: "error" },
  };
}

function flip(field: string, value: unknown): { call: ToolCall; result: CanonicalToolResultView } {
  const id = `c${++seq}`;
  return {
    call: { toolCallId: id, tool: "setting", args: { field, value } },
    result: { toolName: "setting", toolCallId: id, content: `ok: ${field}=${value}`, status: "ok" },
  };
}

function success(tool: string, content = "ok"): { call: ToolCall; result: CanonicalToolResultView } {
  const id = `c${++seq}`;
  return {
    call: { toolCallId: id, tool, args: {} },
    result: { toolName: tool, toolCallId: id, content, status: "ok" },
  };
}

/** Run one afterToolExecution batch through the guard. */
async function run(op: Op, steps: Array<{ call: ToolCall; result: CanonicalToolResultView }>) {
  const ctx = mkCtx(op, steps.map((s) => s.call), steps.map((s) => s.result));
  return thrashGuardMiddleware.afterToolExecution!(ctx);
}

beforeEach(() => _resetMiddlewareStates());

describe("thrash-guard middleware", () => {
  it("replays the 2026-07-20 incident: two flip-then-refail cycles → nudge naming the fields", async () => {
    const op = mkOp();
    const r = await run(op, [
      fail("browser", "Blocked: script contains restricted pattern"),
      fail("browser", 'no clickable element matching text "S54488" found'),
      flip("browserMode", "isolated"),                    // reactive flip 1
      // Current wedge-recovery wording (browser-tools wedgeRecoveryMessage).
      // The guard keys on the result STATUS ("error"), never on this prose —
      // reworded recovery messages must keep tripping it.
      fail("browser", "The browser hung on that action, but the page is still responsive — the browser recovered in place (same tab, same page). The action did not complete; simply retry it."), // cycle 1
      flip("browserMode", "advanced-shared"),             // reactive flip 2
      fail("http_request", "HTTP 400 Bad Request"),       // cycle 2
    ]);
    expect(r.kind).toBe("nudge");
    if (r.kind === "nudge") {
      expect(r.reason).toBe("thrash-guard");
      expect(r.message).toContain("browserMode");
      expect(r.message).toContain("ask how they want to proceed");
    }
  });

  it("stays quiet on a user-requested flip with no failures behind it", async () => {
    const op = mkOp();
    const r = await run(op, [
      flip("browserMode", "isolated"),
      flip("enableShell", false),
    ]);
    expect(r.kind).toBe("continue");
  });

  it("a flip that RESOLVES the failure (no refail) never completes a cycle", async () => {
    const op = mkOp();
    const r = await run(op, [
      fail("browser", "some error"),
      flip("browserMode", "isolated"),
      // browser now succeeds — no further failure, no cycle
      { call: { toolCallId: "cok", tool: "browser", args: {} },
        result: { toolName: "browser", toolCallId: "cok", content: "page loaded", status: "ok" } },
    ]);
    expect(r.kind).toBe("continue");
  });

  it("successful progress disarms a reactive flip before a later unrelated failure", async () => {
    const op = mkOp();
    expect((await run(op, [fail("browser", "old route failed")])).kind).toBe("continue");
    expect((await run(op, [flip("browserMode", "isolated")])).kind).toBe("continue");
    expect((await run(op, [success("browser", "page loaded")])).kind).toBe("continue");

    // This later failure belongs to a new incident. It must not complete the
    // old flip-then-refail cycle or leave the old failure count armed.
    expect((await run(op, [fail("http_request", "unrelated outage")])).kind).toBe("continue");
    expect((await run(op, [flip("browserMode", "in-app")])).kind).toBe("continue");
    const r = await run(op, [fail("browser", "new route failed")]);
    expect(r.kind).toBe("continue");
  });

  it("non-protected setting flips (theme) are ignored", async () => {
    const op = mkOp();
    const r = await run(op, [
      fail("browser", "err A"),
      flip("theme", "dark"),
      fail("browser", "err B"),
      flip("theme", "light"),
      fail("browser", "err C"),
    ]);
    expect(r.kind).toBe("continue");
  });

  it("state accumulates across turns of the same op (nudge fires once)", async () => {
    const op = mkOp();
    let r = await run(op, [
      fail("browser", "err A"),
      flip("browserMode", "isolated"),
      fail("browser", "err B"), // cycle 1
    ]);
    expect(r.kind).toBe("continue");
    r = await run(op, [
      flip("browserMode", "in-app"), // reactive (failure since last flip)... wait: failuresSinceFlip reset
      fail("browser", "err C"),
    ]);
    // second turn: flip after err B (still counted) then refail → cycle 2 → nudge
    expect(r.kind).toBe("nudge");
    // Nudge fires once; further continues until abort threshold.
    r = await run(op, [fail("browser", "err D")]);
    expect(r.kind).toBe("continue");
  });

  it("four cycles → abort on interactive lane, suspend on worker lane", async () => {
    const mkCycle = (n: number) => [
      fail("browser", `err ${n}`),
      flip("browserMode", n % 2 ? "isolated" : "in-app"),
      fail("browser", `refail ${n}`),
    ];
    const interactive = mkOp("interactive");
    let r: Awaited<ReturnType<typeof run>> = { kind: "continue" };
    for (let n = 1; n <= 4; n++) r = await run(interactive, mkCycle(n));
    expect(r.kind).toBe("abort");

    const worker = mkOp("agent");
    for (let n = 1; n <= 4; n++) r = await run(worker, mkCycle(n));
    expect(r.kind).toBe("suspend");
  });

  it("failures alone (no flips) never trip it — repeat-failure's territory", async () => {
    const op = mkOp();
    const r = await run(op, [
      fail("browser", "err 1"),
      fail("browser", "err 2"),
      fail("browser", "err 3"),
      fail("browser", "err 4"),
      fail("browser", "err 5"),
      fail("browser", "err 6"),
    ]);
    expect(r.kind).toBe("continue");
  });
});
