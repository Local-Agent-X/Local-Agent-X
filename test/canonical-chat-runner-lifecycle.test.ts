import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../src/canonical-loop/adapter-contract.js";
import type { CanonicalChatContext } from "../src/canonical-loop/chat-runner.js";
import type { CanonicalEvent } from "../src/canonical-loop/types.js";
import type { SecurityLayer } from "../src/security/index.js";
import type { ServerEvent, ToolDefinition } from "../src/types.js";

const adapterFactories = vi.hoisted(() => new Map<string, () => Adapter>());

vi.mock("../src/canonical-loop/chat-runner/register-adapter.js", () => ({
  registerAdapterForChat: async (opId: string, _prepared: unknown, sessionId: string) => {
    const factory = adapterFactories.get(sessionId);
    if (!factory) throw new Error(`missing fake adapter for ${sessionId}`);
    const { registerAdapterForOp } = await import("../src/canonical-loop/runtime.js");
    registerAdapterForOp(opId, factory);
  },
}));

import { runChatViaCanonical } from "../src/canonical-loop/chat-runner.js";
import {
  awaitIdle,
  getOpBaselineTokens,
  getToolDispatcher,
  getToolsForOp,
  readCanonicalEvents,
  resetBus,
  resetCanonicalRuntime,
  resetScheduler,
  resolveAdapterFactory,
  setToolDispatcher,
} from "../src/canonical-loop/index.js";
import { readOp } from "../src/ops/op-store.js";
import { FakeAdapter, scriptLongStreamingTurn, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const trackedIds = new Set<string>();
const fallbackDispatcher = {
  dispatch: vi.fn(async (call: { toolCallId: string }) => ({
    toolCallId: call.toolCallId,
    status: "ok" as const,
    result: "",
    durationMs: 0,
  })),
};

beforeEach(() => {
  adapterFactories.clear();
  resetCanonicalRuntime();
  resetScheduler();
  resetBus();
  setToolDispatcher(fallbackDispatcher);
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  for (const opId of trackedIds) {
    const dir = join(OPS_BASE, opId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  trackedIds.clear();
});

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
  };
}

function context(sessionId: string, toolName: string, signal?: AbortSignal): CanonicalChatContext {
  const tools = [tool(toolName)];
  return {
    message: `message for ${sessionId}`,
    sessionId,
    prepared: {
      provider: "anthropic",
      apiKey: "test",
      model: "claude-sonnet-4-5",
      systemPrompt: `system ${sessionId}`,
      tools,
      cleanHistory: [],
      images: [],
      temperature: 0,
      maxIterations: 3,
    },
    tools,
    security: {} as SecurityLayer,
    signal,
  };
}

async function collect(ctx: CanonicalChatContext, seen: ServerEvent[] = []): Promise<ServerEvent[]> {
  for await (const event of runChatViaCanonical(ctx)) {
    seen.push(event);
    if (event.type === "chat_op_started") trackedIds.add(event.opId);
  }
  return seen;
}

async function waitForStarted(events: ServerEvent[], timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const started = events.find((event): event is Extract<ServerEvent, { type: "chat_op_started" }> =>
      event.type === "chat_op_started");
    if (started) return started.opId;
    if (Date.now() > deadline) throw new Error("chat_op_started was not emitted");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function eventTypes(opId: string): CanonicalEvent["type"][] {
  return readCanonicalEvents(opId).map(event => event.type);
}

function expectRuntimeClean(opId: string): void {
  const op = readOp(opId);
  expect(op).not.toBeNull();
  expect(resolveAdapterFactory(op!)).toBeNull();
  expect(getToolDispatcher(opId)).toBe(fallbackDispatcher);
  expect(getToolsForOp(opId)).toEqual([]);
  expect(getOpBaselineTokens(opId)).toBe(0);
}

describe("canonical chat runner lifecycle contract", () => {
  it("preserves success event order and clears every per-op registration", async () => {
    const adapter = new FakeAdapter({ script: [scriptTurn({ text: "done", terminal: "done" })] });
    adapterFactories.set("success", () => adapter);

    const events = await collect(context("success", "success_tool"));
    const opId = await waitForStarted(events);

    expect(eventTypes(opId)).toEqual([
      "state_changed",
      "lease_acquired",
      "state_changed",
      "turn_started",
      "message_appended",
      "turn_committed",
      "state_changed",
      "lease_lost",
    ]);
    expect(adapter.turnInputs[0].tools.map(entry => entry.name)).toEqual(["success_tool"]);
    expect(events.at(-1)?.type).toBe("done");
    expectRuntimeClean(opId);
  });

  it("routes external abort through canonical cancellation before cleanup", async () => {
    const controller = new AbortController();
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 10, maxChunks: 200 })],
    });
    adapterFactories.set("abort", () => adapter);
    const seen: ServerEvent[] = [];
    const running = collect(context("abort", "abort_tool", controller.signal), seen);
    const opId = await waitForStarted(seen);
    while (adapter.turnInputs.length === 0) await new Promise(resolve => setTimeout(resolve, 5));

    controller.abort();
    await running;

    const types = eventTypes(opId);
    expect(types.indexOf("cancel_requested")).toBeLessThan(types.lastIndexOf("state_changed"));
    expect(types.at(-1)).toBe("lease_lost");
    expect(readOp(opId)?.canonical?.state).toBe("cancelled");
    expect(types).not.toContain("turn_committed");
    expect(adapter.abortCalls).toBeGreaterThan(0);
    expectRuntimeClean(opId);
  });

  it("keeps adapter-reported errors ordered before failure and cleans registrations", async () => {
    const adapter = new FakeAdapter({
      script: [scriptTurn({
        errorReports: [{ code: "provider_error", message: "failed", retryable: false }],
        terminal: "error",
      })],
    });
    adapterFactories.set("error", () => adapter);

    const events = await collect(context("error", "error_tool"));
    const opId = await waitForStarted(events);
    const canonical = readCanonicalEvents(opId);
    const error = canonical.find(event => event.type === "error");
    const failed = canonical.find(event =>
      event.type === "state_changed" && (event.body as { to?: string })?.to === "failed");

    expect(error).toBeDefined();
    expect(failed).toBeDefined();
    expect(error!.seq).toBeLessThan(failed!.seq);
    expect(readOp(opId)?.canonical?.state).toBe("failed");
    expectRuntimeClean(opId);
  });

  it("isolates registrations and cleanup across concurrent chat ops", async () => {
    const first = new FakeAdapter({
      script: [scriptTurn({ text: "first", streamChunks: [{ delta: "a" }], terminal: "done" })],
    });
    const second = new FakeAdapter({
      script: [scriptTurn({ text: "second", streamChunks: [{ delta: "b" }], terminal: "done" })],
    });
    adapterFactories.set("concurrent-a", () => first);
    adapterFactories.set("concurrent-b", () => second);

    const [eventsA, eventsB] = await Promise.all([
      collect(context("concurrent-a", "tool_a")),
      collect(context("concurrent-b", "tool_b")),
    ]);
    const opA = await waitForStarted(eventsA);
    const opB = await waitForStarted(eventsB);

    expect(opA).not.toBe(opB);
    expect(first.turnInputs[0].opId).toBe(opA);
    expect(second.turnInputs[0].opId).toBe(opB);
    expect(first.turnInputs[0].tools.map(entry => entry.name)).toEqual(["tool_a"]);
    expect(second.turnInputs[0].tools.map(entry => entry.name)).toEqual(["tool_b"]);
    expect(readCanonicalEvents(opA).every(event => event.opId === opA)).toBe(true);
    expect(readCanonicalEvents(opB).every(event => event.opId === opB)).toBe(true);
    expectRuntimeClean(opA);
    expectRuntimeClean(opB);
  });
});
