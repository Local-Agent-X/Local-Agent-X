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

  it("retries a transient error result from a real HTTP GET definition", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const execute = vi.fn()
      .mockResolvedValueOnce({ content: "HTTP 503 Service Unavailable", isError: true, metadata: { status: 503 } })
      .mockResolvedValueOnce({ content: "ok" });
    const tool = { ...createHttpRequestTool(), execute };

    const ctx = await runWithTimers(tool, { url: "https://example.test", method: "GET" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(ctx.result?.content).toBe("ok");
  });

  it("retries a transient snapshot-style browser result", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const execute = vi.fn()
      .mockResolvedValueOnce({ content: "Browser timeout: page could not be read.", isError: true })
      .mockResolvedValueOnce({ content: "snapshot" });
    const tool = { ...createBrowserTools()[0], execute };

    const ctx = await runWithTimers(tool, { action: "snapshot" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(ctx.result?.content).toBe("snapshot");
  });

  it("pins the exact key and isolates retries from tool argument mutation", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const seen: Array<{ key: unknown; value: unknown; frozen: boolean }> = [];
    const effectViews: Array<{ key: unknown; frozen: boolean; nestedFrozen: boolean }> = [];
    let effectCalls = 0;
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      const payload = args.payload as { nested: { value: string } };
      seen.push({ key: args.idempotency_key, value: payload.nested.value, frozen: Object.isFrozen(args) });
      if (seen.length === 1) {
        args.idempotency_key = "attacker-rewrite";
        payload.nested.value = "mutated";
        return { content: "503 Service Unavailable", isError: true };
      }
      return { content: "created" };
    });
    const http = createHttpRequestTool();
    const tool: ToolDefinition = {
      ...http,
      effect: (args) => {
        effectCalls++;
        effectViews.push({
          key: args.idempotency_key,
          frozen: Object.isFrozen(args),
          nestedFrozen: Object.isFrozen((args.payload as { nested: object }).nested),
        });
        return typeof http.effect === "function" ? http.effect(args) : http.effect!;
      },
      execute,
    };

    const ctx = await runWithTimers(tool, {
      url: "https://example.test/orders",
      method: "POST",
      idempotency_key: "  order-7f3a  ",
      payload: { nested: { value: "original" } },
    });

    expect(effectCalls).toBe(1);
    expect(effectViews).toEqual([{
      key: "  order-7f3a  ",
      frozen: true,
      nestedFrozen: true,
    }]);
    expect(seen).toEqual([
      { key: "  order-7f3a  ", value: "original", frozen: false },
      { key: "  order-7f3a  ", value: "original", frozen: false },
    ]);
    expect(ctx.result?.content).toBe("created");
  });

  it("preserves a nontransient error result without retrying", async () => {
    vi.useFakeTimers();
    const result = { content: "HTTP 400 Bad Request", isError: true, metadata: { status: 400 } };
    const execute = vi.fn(async () => result);
    const tool = { ...createHttpRequestTool(), execute };

    const ctx = await runWithTimers(tool, { url: "https://example.test", method: "GET" });

    expect(execute).toHaveBeenCalledOnce();
    expect(ctx.result).toBe(result);
  });

  it("never retries a returned transient error for a non-idempotent effect", async () => {
    vi.useFakeTimers();
    const result = { content: "503 Service Unavailable", isError: true };
    const execute = vi.fn(async () => result);
    const tool: ToolDefinition = {
      name: "send_payment",
      description: "test",
      parameters: {},
      effect: { class: "non-idempotent" },
      execute,
    };

    const ctx = await runWithTimers(tool, { amount: 25 });

    expect(execute).toHaveBeenCalledOnce();
    expect(ctx.result).toBe(result);
  });

  it("caps persistent returned 503 errors at three attempts and preserves the final result", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const results = [1, 2, 3].map(attempt => ({
      content: `upstream unavailable on attempt ${attempt}`,
      isError: true,
      metadata: { status: 503, attempt },
    }));
    const execute = vi.fn()
      .mockResolvedValueOnce(results[0])
      .mockResolvedValueOnce(results[1])
      .mockResolvedValueOnce(results[2]);
    const tool = { ...createHttpRequestTool(), execute };

    const ctx = await runWithTimers(tool, { url: "https://example.test", method: "GET" });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(ctx.result).toBe(results[2]);
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
