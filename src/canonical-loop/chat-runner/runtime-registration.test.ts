// The op baseline (system prompt + tool manifest estimate) must be registered
// for EVERY model at submit. It used to be Anthropic-only, so a local
// openai-compat model compacted history against its raw window with nothing
// reserved for the fixed overhead — incident 2026-09-08: a 65k-window local
// model grew history until the ~13k-token manifest no longer fit and the
// adapter stripped tools mid-turn.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./register-adapter.js", () => ({ registerAdapterForChat: vi.fn(async () => {}) }));
vi.mock("../chat-tool-dispatcher.js", () => ({ makeChatToolDispatcher: vi.fn(() => ({})) }));

import { registerChatRuntime, type ChatRuntimeRegistration } from "./runtime-registration.js";
import { getOpBaselineTokens, getToolsForOp } from "../runtime.js";
import type { CanonicalChatContext } from "../chat-runner.js";

function ctxFor(model: string, provider: string): CanonicalChatContext {
  return {
    message: "help",
    sessionId: "sess-rr-test",
    prepared: {
      provider,
      model,
      systemPrompt: "You are a careful assistant. ".repeat(40),
      tools: [{
        name: "read_file",
        description: "Read a file from disk. ".repeat(10),
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    },
    tools: [{
      name: "read_file",
      description: "Read a file from disk. ".repeat(10),
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
    security: {},
  } as unknown as CanonicalChatContext;
}

describe("registerChatRuntime — op baseline registration", () => {
  let seq = 0;
  let opId = "";
  let registration: ChatRuntimeRegistration | null = null;

  afterEach(() => {
    registration?.dispose();
    registration = null;
  });

  async function register(model: string, provider: string): Promise<void> {
    opId = `op_rr_test_${seq++}`;
    registration = await registerChatRuntime(opId, ctxFor(model, provider), new AbortController().signal, null);
  }

  it("registers a baseline for a local openai-compat model (the incident case)", async () => {
    await register("muse-glimmer:30b", "local");
    expect(getOpBaselineTokens(opId)).toBeGreaterThan(0);
    expect(getToolsForOp(opId).map(t => t.name)).toEqual(["read_file"]);
  });

  it("registers a baseline for an Anthropic model (unchanged)", async () => {
    await register("claude-sonnet-4-6", "anthropic");
    expect(getOpBaselineTokens(opId)).toBeGreaterThan(0);
  });

  it("the baseline covers BOTH the system prompt and the tool manifest", async () => {
    await register("muse-glimmer:30b", "local");
    const withTools = getOpBaselineTokens(opId);
    registration?.dispose();
    const noTools = ctxFor("muse-glimmer:30b", "local");
    noTools.tools = [];
    opId = `op_rr_test_${seq++}`;
    registration = await registerChatRuntime(opId, noTools, new AbortController().signal, null);
    const promptOnly = getOpBaselineTokens(opId);
    expect(promptOnly).toBeGreaterThan(0);
    expect(withTools).toBeGreaterThan(promptOnly);
  });

  it("dispose releases the baseline with the rest of the registration", async () => {
    await register("muse-glimmer:30b", "local");
    registration?.dispose();
    registration = null;
    expect(getOpBaselineTokens(opId)).toBe(0);
    expect(getToolsForOp(opId)).toEqual([]);
  });
});
