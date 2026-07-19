/**
 * Orphaned-ActiveChat net for the delegation ack turn (2026-07-13 audit,
 * skeptic round 2). runDelegationHandoff calls ctx.chatWs.startChat directly;
 * a throw after it (runAgentViaCanonical, saveSession) propagates to the
 * orchestrator's catch, whose emitTurnError is broadcast-only — the entry's
 * done flag stays false and the entry leaks (stale replay buffer, startChat
 * overwrite warnings, immortal heartbeat). The handoff's own catch must
 * terminate ITS entry via the identity-guarded failChatIfCurrent (token =
 * the startChat return's abort controller) and rethrow; on the happy path
 * the terminal done goes through wsChat.onEvent, so the net never fires.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ServerEvent } from "../../types.js";
import {
  createPromptTelemetry,
  measurePromptSection,
  type PromptTelemetry,
} from "../../prompt-telemetry.js";
import { renderPromptSection, type RenderedPromptSection } from "../../context/system-prompt-builder.js";

const { runAgentViaCanonical } = vi.hoisted(() => ({
  runAgentViaCanonical: vi.fn(async () => ({
    messages: [] as unknown[],
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  })),
}));
vi.mock("../../canonical-loop/index.js", () => ({
  runAgentViaCanonical,
  canonicalLoopEntry: vi.fn(),
}));
vi.mock("../../ops/op-store.js", () => ({ newOpId: vi.fn(() => "op_freeform_test") }));
vi.mock("../../ops/context-pack-builder.js", () => ({ buildContextPack: vi.fn(async () => ({})) }));
vi.mock("../../ops/heartbeat.js", () => ({ getRetryPolicy: vi.fn(() => ({})) }));
vi.mock("../../ops/session-bridge.js", () => ({ trackOpForSession: vi.fn() }));
vi.mock("../../routing/index.js", () => ({ linkDecisionToOpId: vi.fn() }));
vi.mock("../../threat/threat-engine.js", () => ({
  ThreatEngine: class { constructor(_dataDir: string, _sessionId: string) {} },
}));
vi.mock("../../providers/sanitize.js", () => ({
  stripEphemeralMessages: vi.fn((m: unknown[]) => m),
}));

import { runDelegationHandoff } from "./delegation-handoff.js";

const SESSION = "sess-delegation-net";

afterEach(() => {
  vi.clearAllMocks();
});

function makeCtx() {
  const abort = new AbortController();
  const wsOnEvent = vi.fn((_ev: ServerEvent) => {});
  const ctx = {
    dataDir: "/tmp",
    security: {},
    toolPolicy: {},
    rbac: {},
    saveSession: vi.fn(),
    setActiveOnEvent: vi.fn(),
    chatWs: {
      startChat: vi.fn(() => ({ abort, onEvent: wsOnEvent })),
      failChatIfCurrent: vi.fn((_sid: string, _token: AbortController, _msg: string) => true),
    },
  };
  return { ctx, abort, wsOnEvent };
}

function makeArgs(ctx: unknown) {
  return {
    message: "build me a thing",
    sessionId: SESSION,
    prepared: {
      apiKey: "k", model: "grok", provider: "xai",
      systemPrompt: "sys", cleanHistory: [] as unknown[],
      renderedPromptSections: [renderPromptSection({
        id: "core", label: "Core", type: "static", policy: "required", text: "sys",
      })],
      promptTelemetry: createPromptTelemetry({
        profile: "full", provider: "xai", model: "grok", prompt: "sys",
        tools: [], allToolCount: 0, historyMessageCount: 0,
        sections: [measurePromptSection("core", "static", "sys")],
      }),
    },
    ctx: ctx as never,
    session: { messages: [] as unknown[], updatedAt: 0 },
    requestRole: "operator" as const,
    sseSink: null,
  };
}

describe("delegation-handoff orphaned-ActiveChat net", () => {
  it("terminates its OWN entry (token-guarded) and rethrows when the ack turn dies", async () => {
    runAgentViaCanonical.mockRejectedValueOnce(new Error("provider died mid-ack"));
    const { ctx, abort } = makeCtx();

    await expect(runDelegationHandoff(makeArgs(ctx) as never)).rejects.toThrow("provider died mid-ack");

    // Identity-guarded terminate with THIS turn's startChat token and no
    // extra error bubble (the orchestrator's emitTurnError owns that).
    expect(ctx.chatWs.failChatIfCurrent).toHaveBeenCalledTimes(1);
    expect(ctx.chatWs.failChatIfCurrent).toHaveBeenCalledWith(SESSION, abort, "");
  });

  it("happy path: done reaches wsChat.onEvent and the net never fires", async () => {
    const { ctx, wsOnEvent } = makeCtx();

    const result = await runDelegationHandoff(makeArgs(ctx) as never);

    expect(result).toEqual({ onEventInstalled: true, doneEmitted: true });
    // The terminal done flowed through the entry's own onEvent — in the real
    // manager this marks the entry done, so no net is needed (and it would
    // no-op anyway).
    const doneCalls = wsOnEvent.mock.calls.filter(([ev]) => ev.type === "done");
    expect(doneCalls).toHaveLength(1);
    expect(ctx.chatWs.failChatIfCurrent).not.toHaveBeenCalled();
  });

  it("passes content-free final prompt telemetry to the canonical ack operation", async () => {
    const { ctx } = makeCtx();

    await runDelegationHandoff(makeArgs(ctx) as never);

    const calls = runAgentViaCanonical.mock.calls as unknown as Array<[
      string,
      unknown[],
      { systemPrompt: string; promptTelemetry: PromptTelemetry; renderedPromptSections: RenderedPromptSection[] },
    ]>;
    const options = calls.at(-1)![2];
    expect(options.promptTelemetry.characters).toBe(options.systemPrompt.length);
    expect(options.promptTelemetry.loadedToolCount).toBe(0);
    expect(options.promptTelemetry.sections.at(-1)?.id).toBe("delegation-ack");
    expect(options.renderedPromptSections.at(-1)).toMatchObject({
      id: "delegation-ack",
      policy: "required",
    });
    expect(JSON.stringify(options.promptTelemetry)).not.toContain("op_freeform_test");
    expect(JSON.stringify(options.promptTelemetry)).not.toContain("build me a thing");
  });
});
