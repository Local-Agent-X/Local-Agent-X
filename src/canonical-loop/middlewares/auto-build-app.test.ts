/**
 * Behavior tests for the auto-build-app middleware: when the model emitted a
 * build-intent commitment in prose but called no tools, synthesize a
 * build_app tool call in ctx.toolCalls so the loop executes the build this
 * turn instead of accepting the prose claim. Anthropic-only via `when`.
 */
import { describe, it, expect, vi } from "vitest";
import { autoBuildAppMiddleware } from "./auto-build-app.js";
import type { CanonicalLoopContext } from "./types.js";
import type { ToolCall } from "../contract-types.js";

let _op = 0;
const opId = () => `op-aba-test-${++_op}`;

const BUILD_ASK = "Can you build me a todo app?";
const COMMITMENT = "I'll write the files to workspace/apps/todo-pro now.";

function ctxFor(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: opId(), lane: "agent" },
    provider: "anthropic",
    userMessage: BUILD_ASK,
    assistantContent: COMMITMENT,
    toolCalls: [] as ToolCall[],
    toolNames: new Set(["build_app", "bash", "write"]),
    onEvent: vi.fn(),
    ...over,
  } as unknown as CanonicalLoopContext;
}

const run = (c: CanonicalLoopContext) => autoBuildAppMiddleware.afterModelCall!(c);

describe("auto-build-app — when gate", () => {
  it("applies only to the anthropic provider", () => {
    expect(autoBuildAppMiddleware.when!(ctxFor())).toBe(true);
    expect(autoBuildAppMiddleware.when!(ctxFor({ provider: "codex" }))).toBe(false);
    expect(autoBuildAppMiddleware.when!(ctxFor({ provider: "openai" }))).toBe(false);
  });
});

describe("auto-build-app middleware", () => {
  it("synthesizes a build_app call for a tool-less build commitment", async () => {
    const ctx = ctxFor();
    const r = await run(ctx);
    // Continue, not nudge — the synthetic call rides THIS turn's dispatch.
    expect(r.kind).toBe("continue");
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0]).toMatchObject({ tool: "build_app" });
    const args = ctx.toolCalls[0].args as { name: string; prompt: string };
    // App name lifted from the workspace/apps/<name> path in the reply.
    expect(args.name).toBe("todo-pro");
    // The build prompt carries the user's actual request.
    expect(args.prompt).toContain(`User request: ${BUILD_ASK}`);
  });

  it("streams a visible '*Building app...*' note when it routes", async () => {
    const ctx = ctxFor();
    await run(ctx);
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stream", delta: expect.stringContaining("Building app") }),
    );
  });

  it("leaves a turn that already called tools alone", async () => {
    const existing: ToolCall = { toolCallId: "b1", tool: "bash", args: { command: "ls" } };
    const ctx = ctxFor({ toolCalls: [existing] });
    await run(ctx);
    expect(ctx.toolCalls).toEqual([existing]);
  });

  it("does nothing when build_app is not among the advertised tools", async () => {
    const ctx = ctxFor({ toolNames: new Set(["bash", "write"]) });
    await run(ctx);
    expect(ctx.toolCalls).toHaveLength(0);
  });

  it("does not route on a clarifying question — the model hasn't committed yet", async () => {
    const ctx = ctxFor({
      assistantContent: "Do you want React or plain HTML for the todo app?",
    });
    await run(ctx);
    expect(ctx.toolCalls).toHaveLength(0);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it("does not route on non-committal prose even for a build-shaped ask", async () => {
    const ctx = ctxFor({
      assistantContent: "A todo app would need a list view, a form, and local storage.",
    });
    await run(ctx);
    expect(ctx.toolCalls).toHaveLength(0);
  });

  it("does not route when the user message isn't build-shaped and the reply lacks the standalone commitment", async () => {
    const ctx = ctxFor({
      userMessage: "What's in workspace/apps right now?",
      assistantContent: "workspace/apps/todo-pro is the only project there.",
    });
    await run(ctx);
    expect(ctx.toolCalls).toHaveLength(0);
  });
});
