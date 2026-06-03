import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the on-disk tool-timeouts.json under a temp LAX dir so setToolTimeout
// in the regression test never touches the developer's ~/.lax config.
let tmp: string;
const prevLaxDir = process.env.LAX_DATA_DIR;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lax-tool-timeout-"));
  process.env.LAX_DATA_DIR = tmp;
});
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

// A promise that resolves after `ms` via an unref'd timer so a test never
// leaks a pending handle even when withTimeout abandons (orphans) it.
function resolvesAfter(ms: number): Promise<string> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("done"), ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

describe("withTimeout", () => {
  it("rejects with a ToolTimeoutError when the promise outlives the deadline", async () => {
    const { withTimeout, ToolTimeoutError } = await import("./tool-timeout.js");
    await expect(withTimeout(resolvesAfter(100), 20, "x")).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("resolves normally when the promise beats the deadline", async () => {
    const { withTimeout } = await import("./tool-timeout.js");
    await expect(withTimeout(resolvesAfter(5), 1000, "x")).resolves.toBe("done");
  });
});

describe("getToolTimeout exemptions", () => {
  it("returns 0 (unbounded) for known long-runners", async () => {
    const { getToolTimeout } = await import("./tool-timeout.js");
    // self_edit drives a CLI subprocess for minutes — must be exempt.
    expect(getToolTimeout("self_edit")).toBe(0);
    // Spot-check the other documented long-runners all map to unbounded.
    for (const name of ["build_app", "agent_spawn", "delegate", "op_submit", "operation_start"]) {
      expect(getToolTimeout(name)).toBe(0);
    }
  });

  it("bounds the network/verification tools generously", async () => {
    const { getToolTimeout } = await import("./tool-timeout.js");
    expect(getToolTimeout("http_request")).toBe(60_000);
    expect(getToolTimeout("web_fetch")).toBe(60_000);
  });

  it("falls back to a generous (not premature) timeout for unlisted tools", async () => {
    const { getToolTimeout, DEFAULT_FALLBACK } = await import("./tool-timeout.js");
    expect(DEFAULT_FALLBACK).toBe(120_000);
    expect(getToolTimeout("some_unlisted_tool_xyz")).toBe(120_000);
  });
});

// Regression for the real bug: a hung tool must leave a status:"timeout"
// result row on ctx, NOT a missing result (which strands the model into
// narrating "done" against silence).
describe("runSandboxedPhase hang → timeout result row", () => {
  it("maps a hung tool to a status:'timeout' ToolResult", async () => {
    const { setToolTimeout } = await import("./tool-timeout.js");
    const { runSandboxedPhase } = await import("./tool-execution/run-sandboxed.js");

    const hangName = "__lax_test_hang_tool";
    setToolTimeout(hangName, 20); // tiny, non-exempt deadline

    const tool = {
      name: hangName,
      description: "never resolves in time",
      parameters: { type: "object", properties: {} },
      // Orphaned after the timeout fires; unref'd so it can't leak a handle.
      execute: () => resolvesAfter(500).then((s) => ({ content: s })),
    };

    // Minimal ctx: the phase only reads tc/tool/args/sessionId/signal/onEvent
    // and writes startedAt/result. The taint + stats side-effects tolerate the
    // sparse shape (they're each wrapped in try/catch).
    const ctx = {
      tc: { id: "call_1", name: hangName, arguments: "{}" },
      tool,
      args: {} as Record<string, unknown>,
      sessionId: "test-session",
    } as unknown as Parameters<typeof runSandboxedPhase>[0];

    await runSandboxedPhase(ctx);

    expect(ctx.result).toBeDefined();
    expect(ctx.result!.status).toBe("timeout");
    expect(ctx.result!.isError).toBe(true);
    expect(ctx.result!.metadata?.recovery).toContain("process_status");
  });

  it("runs an exempt tool (timeout 0) unbounded — no wrap, normal result", async () => {
    const { setToolTimeout } = await import("./tool-timeout.js");
    const { runSandboxedPhase } = await import("./tool-execution/run-sandboxed.js");

    const exemptName = "__lax_test_exempt_tool";
    setToolTimeout(exemptName, 0); // unbounded

    const tool = {
      name: exemptName,
      description: "exempt long-runner",
      parameters: { type: "object", properties: {} },
      execute: () => Promise.resolve({ content: "finished" }),
    };

    const ctx = {
      tc: { id: "call_2", name: exemptName, arguments: "{}" },
      tool,
      args: {} as Record<string, unknown>,
      sessionId: "test-session",
    } as unknown as Parameters<typeof runSandboxedPhase>[0];

    await runSandboxedPhase(ctx);

    expect(ctx.result).toBeDefined();
    expect(ctx.result!.content).toBe("finished");
    expect(ctx.result!.status).not.toBe("timeout");
  });
});
