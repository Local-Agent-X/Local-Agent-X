// C6-polish F2 — the ONE production wiring of the chat lane's stable/volatile
// system-prompt cache split.
//
// `stableSystemPrefixLength()` has thorough unit coverage, and stream-api's
// `splitSystemBlocks()` has thorough unit coverage, but nothing exercised the
// single line that JOINS them: register-adapter.ts's `anthropic` branch passing
// `systemStablePrefixLen` into `createAnthropicAdapter`. Two mutations reverted
// the entire feature with a green suite:
//
//   1. delete the `systemStablePrefixLen:` line — the option becomes undefined
//      and splitSystemBlocks falls back to a single block.
//   2. pass `prepared.systemPrompt.length` — splitSystemBlocks' guard is
//      `stableLen < systemPrompt.length`, so it ALSO silently falls back to a
//      single block. Same revert, no error, no failing test.
//
// Both are now red: (1) trips `toBeGreaterThan(0)`, (2) trips
// `toBeLessThan(systemPrompt.length)`. The third assertion pins the property
// that makes the value usable at all — that the value indexes a genuine
// contiguous byte PREFIX of the prompt, since stream-api slices with it.
//
// register-adapter.ts is NOT edited by this test; it is asserted as-is.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPromptTelemetry, measurePromptSection } from "../src/prompt-telemetry.js";
import type { PreparedAgentRequest } from "../src/agent-request/types.js";

type AdapterFactory = () => unknown;

const registered: Array<{ opId: string; factory: AdapterFactory }> = [];
const anthropicOpts: Array<Record<string, unknown>> = [];

vi.mock("../src/canonical-loop/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    registerAdapterForOp: (opId: string, factory: AdapterFactory) => {
      registered.push({ opId, factory });
    },
  };
});

vi.mock("../src/canonical-loop/adapters/anthropic.js", () => ({
  createAnthropicAdapter: (opts: Record<string, unknown>) => {
    anthropicOpts.push(opts);
    return { id: "stub-anthropic-adapter" };
  },
}));

import { registerAdapterForChat } from "../src/canonical-loop/chat-runner/register-adapter.js";

// A section set shaped like the real builder's output: a stable head, then a
// section the walk must stop at, then a dynamic tail. Concrete texts keep the
// arithmetic checkable by hand.
const STABLE_HEAD = "IDENTITY-BLOCK|RUNTIME-BLOCK";

function preparedAnthropic(): PreparedAgentRequest {
  const parts: Array<[string, "static" | "dynamic", string]> = [
    ["core-identity", "static", "IDENTITY-BLOCK"],
    ["runtime-context", "static", "|RUNTIME-BLOCK"],
    // Turn-variant: the agent's own writes move this mid-session, so the walk
    // must stop here (C6-polish F1).
    ["app-manifest", "static", "|APP MAP WITH FILE COUNTS THAT MOVE"],
    ["tool-guidance", "static", "|PER-TURN DEFERRED MANIFEST"],
    ["turn-directive", "dynamic", "|DO THE THING THIS TURN"],
  ];
  const renderedPromptSections = parts.map(([id, type, text]) => ({
    id,
    label: id,
    type,
    policy: "required" as const,
    text,
    measurement: measurePromptSection(id, type, text),
  }));
  const systemPrompt = renderedPromptSections.map((s) => s.text).join("");
  return {
    provider: "anthropic",
    apiKey: "",
    model: "claude-test",
    systemPrompt,
    tools: [],
    cleanHistory: [],
    images: [],
    temperature: 0.7,
    maxIterations: 30,
    reasoningEffort: "medium",
    promptTelemetry: createPromptTelemetry({
      profile: "full",
      provider: "anthropic",
      model: "claude-test",
      prompt: systemPrompt,
      tools: [],
      allToolCount: 0,
      historyMessageCount: 0,
      sections: renderedPromptSections.map((s) => s.measurement),
    }),
    renderedPromptSections,
    localModelCapabilityProfile: null,
  } as unknown as PreparedAgentRequest;
}

beforeEach(() => {
  registered.length = 0;
  anthropicOpts.length = 0;
});

describe("chat lane wires the system-prompt cache split into the anthropic adapter", () => {
  async function construct(): Promise<Record<string, unknown>> {
    const prepared = preparedAnthropic();
    await registerAdapterForChat("op-c6-wiring", prepared, "sess-c6-wiring");
    expect(registered).toHaveLength(1);
    // The adapter is built lazily inside the registered factory, which is where
    // the split is computed — so the factory must actually run.
    registered[0].factory();
    expect(anthropicOpts).toHaveLength(1);
    return anthropicOpts[0];
  }

  it("constructs the adapter WITH a usable systemStablePrefixLen", async () => {
    const prepared = preparedAnthropic();
    const opts = await construct();

    // Mutation 1 (delete the wiring line) fails here.
    expect(typeof opts.systemStablePrefixLen).toBe("number");
    expect(opts.systemStablePrefixLen as number).toBeGreaterThan(0);
    // Mutation 2 (pass prepared.systemPrompt.length) fails here: stream-api's
    // splitSystemBlocks requires stableLen < systemPrompt.length or it degrades
    // to the legacy single block.
    expect(opts.systemStablePrefixLen as number).toBeLessThan(
      prepared.systemPrompt.length,
    );
  });

  it("the value indexes a real contiguous byte prefix of the system prompt", async () => {
    const opts = await construct();
    const systemPrompt = opts.systemPrompt as string;
    const len = opts.systemStablePrefixLen as number;

    // Exactly what stream-api does with it.
    expect(systemPrompt.slice(0, len)).toBe(STABLE_HEAD);
    expect(systemPrompt.startsWith(systemPrompt.slice(0, len))).toBe(true);
    // And the volatile remainder is non-empty, i.e. the split is a real split.
    expect(systemPrompt.slice(len).length).toBeGreaterThan(0);
  });

  it("still enables the conversation-tier breakpoint alongside the split", async () => {
    const opts = await construct();
    expect(opts.cacheConversation).toBe(true);
  });
});
