import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../types.js";
import type { ToolCallContext } from "./context.js";
import { createHttpRequestTool } from "../tools/http-request.js";
import { createBrowserTools } from "../tools/browser-tools/index.js";
import { isRetryableTool } from "../resilience-policy.js";
import { runSandboxedPhase } from "./run-sandboxed.js";

function context(tool: ToolDefinition, args: Record<string, unknown>): ToolCallContext {
  return {
    tc: { id: "call_retry_effect", name: tool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[tool.name, tool]]),
    security: {} as ToolCallContext["security"],
    callContext: "local",
    args,
    tool,
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
    sessionId: `retry-effect-${Math.random()}`,
  };
}

async function runWithTimers(tool: ToolDefinition, args: Record<string, unknown>) {
  const ctx = context(tool, args);
  const pending = runSandboxedPhase(ctx);
  await vi.runAllTimersAsync();
  await pending;
  return ctx;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tool retry effect policy", () => {
  it("classifies real HTTP and browser calls conservatively", () => {
    const http = createHttpRequestTool();
    const browser = createBrowserTools()[0];

    expect(isRetryableTool(http, { method: "GET" })).toBe(true);
    expect(isRetryableTool(http, { method: "POST" })).toBe(false);
    expect(isRetryableTool(browser, { action: "snapshot" })).toBe(true);
    expect(isRetryableTool(browser, { action: "click" })).toBe(false);
    expect(isRetryableTool(browser, { action: "evaluate" })).toBe(false);
  });

  it("does not re-execute a non-idempotent side effect after an ambiguous timeout", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => {
      throw new Error("ETIMEDOUT after remote side effect");
    });
    const tool: ToolDefinition = {
      name: "send_payment",
      description: "test",
      parameters: {},
      effect: { class: "non-idempotent" },
      execute,
    };

    const ctx = await runWithTimers(tool, { amount: 25 });

    expect(execute).toHaveBeenCalledOnce();
    expect(ctx.result).toMatchObject({ isError: true });
  });

  it("retries a safe HTTP GET", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ content: "ok" });
    const tool = { ...createHttpRequestTool(), execute };

    const ctx = await runWithTimers(tool, { url: "https://example.test", method: "GET" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(ctx.result?.content).toBe("ok");
  });

  it("reuses the exact caller key when retrying a keyed mutation", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const seenKeys: unknown[] = [];
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      seenKeys.push(args.idempotency_key);
      if (seenKeys.length === 1) throw new Error("503 Service Unavailable");
      return { content: "created" };
    });
    const tool = { ...createHttpRequestTool(), execute };

    const ctx = await runWithTimers(tool, {
      url: "https://example.test/orders",
      method: "POST",
      idempotency_key: "order-7f3a",
    });

    expect(seenKeys).toEqual(["order-7f3a", "order-7f3a"]);
    expect(ctx.result?.content).toBe("created");
  });

  it("does not retry an unknown tool without effect metadata", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const tool: ToolDefinition = {
      name: "unclassified_plugin_tool",
      description: "test",
      parameters: {},
      execute,
    };

    await runWithTimers(tool, {});

    expect(execute).toHaveBeenCalledOnce();
  });
});
