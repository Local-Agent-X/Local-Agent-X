/**
 * Eval runner — pipes a fixture through runAgentTurn() with the replay
 * adapter, captures the result, and asserts against fixture.expect.
 *
 * Single-fixture entry point: `runFixture(fixture)`. The CLI wraps
 * this with file IO + a multi-fixture batch mode.
 */

import type {
  Fixture,
  ParityResult,
  RunResult,
} from "./types.js";
import type {
  AgentTurnRequest,
  LoopMiddleware,
} from "../types.js";
import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { AgentOptions } from "../../providers/types.js";
import type { ServerEvent, ToolDefinition, ToolResult } from "../../types.js";
import { SecurityLayer } from "../../security.js";
import { setRegistryOverride } from "../../providers/adapter/registry.js";
import {
  ensureReplayAdapterRegistered,
  replayAdapter,
  setReplayResponses,
  resetReplayState,
  getReplayIteration,
} from "./replay-adapter.js";
import { runAgentTurn } from "../run.js";
import { runStandardAgent } from "../../providers/run-standard.js";

/**
 * Build stub ToolDefinitions whose `execute` returns the canned result
 * from the fixture. Real tool implementations are NOT invoked — fixtures
 * never touch the filesystem or spawn subprocesses.
 */
function buildStubTools(fixture: Fixture): {
  tools: ToolDefinition[];
  observed: Array<{ name: string; arguments: string }>;
} {
  const observed: Array<{ name: string; arguments: string }> = [];
  const tools: ToolDefinition[] = fixture.input.tools.map(stub => {
    return {
      ...stub.definition,
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        observed.push({ name: stub.definition.name, arguments: JSON.stringify(args) });
        // Tool result lookup: by tool_call_id (passed as _toolCallId by
        // executeToolCalls if available), else default. Fixtures usually
        // just supply defaultResult.
        const id = (args._toolCallId as string | undefined) || "";
        const result = stub.results?.[id] ?? stub.defaultResult ?? "(no fixture result)";
        return { content: result };
      },
    };
  });
  return { tools, observed };
}

/**
 * Build the AgentTurnRequest from a fixture. Fills in safe defaults for
 * everything the loop needs but the fixture doesn't care about.
 */
function buildRequest(fixture: Fixture, observed: { events: ServerEvent[] }): AgentTurnRequest {
  const history: ChatCompletionMessageParam[] = (fixture.input.history || []).map(h => {
    if (h.role === "tool") {
      return { role: "tool", content: h.content, tool_call_id: h.toolCallId || "" } as ChatCompletionMessageParam;
    }
    return { role: h.role, content: h.content } as ChatCompletionMessageParam;
  });

  // Throwaway security layer rooted at cwd — fixtures don't touch files.
  const security = new SecurityLayer(process.cwd(), "common");

  return {
    apiKey: "fixture-replay",
    model: "fixture-replay-model",
    provider: "openai", // any value works; replay override ignores name
    systemPrompt: fixture.input.systemPrompt,
    tools: [],          // filled in below by the caller
    security,
    sessionId: `eval-${fixture.name.replace(/\s+/g, "-")}`,
    maxIterations: fixture.input.maxIterations ?? 10,
    temperature: 0.7,
    onEvent: (e) => observed.events.push(e),
    userMessage: fixture.input.userMessage,
    history,
  };
}

/**
 * Run one fixture against the unified loop. Returns a RunResult with
 * captured outputs + assertion verdict.
 */
export async function runFixture(fixture: Fixture): Promise<RunResult> {
  ensureReplayAdapterRegistered();
  setRegistryOverride(replayAdapter);
  setReplayResponses(fixture.responses);

  const observed = { events: [] as ServerEvent[] };
  const { tools, observed: toolObserved } = buildStubTools(fixture);
  const req = buildRequest(fixture, observed);
  req.tools = tools;

  const startedAt = Date.now();
  let turn;
  let iterations = 0;
  try {
    turn = await runAgentTurn(req);
  } finally {
    iterations = getReplayIteration(); // capture BEFORE reset zeros it
    setRegistryOverride(null);
    resetReplayState();
  }
  const durationMs = Date.now() - startedAt;

  const result: RunResult = {
    variant: "unified",
    turn,
    toolCallsObserved: toolObserved,
    events: observed.events,
    durationMs,
    iterations,
    assertionFailure: null,
  };

  // ── Apply assertions ──
  const expect = fixture.expect;
  const expectedStop = expect.stopReason ?? "end_turn";
  if (turn.stopReason !== expectedStop) {
    result.assertionFailure = `stopReason: expected="${expectedStop}" got="${turn.stopReason}"`;
    return result;
  }

  const finalAssistant = lastAssistantText(turn.messages);

  if (expect.assistantContains) {
    for (const needle of expect.assistantContains) {
      if (!finalAssistant.includes(needle)) {
        result.assertionFailure = `assistantContains: expected substring "${needle}" not found in "${finalAssistant.slice(0, 200)}"`;
        return result;
      }
    }
  }

  if (expect.assistantNotContains) {
    for (const needle of expect.assistantNotContains) {
      if (finalAssistant.includes(needle)) {
        result.assertionFailure = `assistantNotContains: forbidden substring "${needle}" appeared in assistant text`;
        return result;
      }
    }
  }

  if (typeof expect.toolCallsCount === "number") {
    if (toolObserved.length !== expect.toolCallsCount) {
      result.assertionFailure = `toolCallsCount: expected=${expect.toolCallsCount} got=${toolObserved.length} (${toolObserved.map(t => t.name).join(",")})`;
      return result;
    }
  }

  if (expect.toolNames) {
    const observedNames = new Set(toolObserved.map(t => t.name));
    for (const name of expect.toolNames) {
      if (!observedNames.has(name)) {
        result.assertionFailure = `toolNames: expected tool "${name}" was never invoked (got: ${[...observedNames].join(",") || "none"})`;
        return result;
      }
    }
  }

  if (expect.errorMessageContains) {
    const errMsg = turn.errorMessage || "";
    if (!errMsg.includes(expect.errorMessageContains)) {
      result.assertionFailure = `errorMessageContains: expected="${expect.errorMessageContains}" got="${errMsg.slice(0, 200)}"`;
      return result;
    }
  }

  return result;
}

function lastAssistantText(messages: ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string") return m.content || "";
  }
  return "";
}

/**
 * Inject custom middlewares for a fixture run. Used in tests that want
 * to verify a specific middleware fires (or doesn't). For now this is
 * a placeholder; the unified loop reads the registry directly. A future
 * commit can thread per-run middleware overrides through ctx.
 */
export function _setFixtureMiddlewareOverride(_overrides: LoopMiddleware[]): void {
  // Stub. Will plumb through agent-loop/run.ts when Phase 2 adds per-run
  // middleware overrides as a first-class param.
}

/**
 * Run one fixture against the LEGACY loop (runStandardAgent — the
 * OpenAI-compat path that the inline chat flow currently calls when
 * LAX_UNIFIED_LOOP is not set). Returns a RunResult with `variant:"legacy"`.
 *
 * Uses the same replay adapter as runFixture(); both loops resolve
 * adapters through requireAdapter() and respect setRegistryOverride().
 * That's the parity hook the registry was designed for — see the
 * comment on setRegistryOverride in providers/adapter/registry.ts.
 */
export async function runLegacyFixture(fixture: Fixture): Promise<RunResult> {
  ensureReplayAdapterRegistered();
  setRegistryOverride(replayAdapter);
  setReplayResponses(fixture.responses);

  const observed = { events: [] as ServerEvent[] };
  const { tools, observed: toolObserved } = buildStubTools(fixture);
  const req = buildRequest(fixture, observed);
  req.tools = tools;

  const history: ChatCompletionMessageParam[] = (fixture.input.history || []).map(h => {
    if (h.role === "tool") {
      return { role: "tool", content: h.content, tool_call_id: h.toolCallId || "" } as ChatCompletionMessageParam;
    }
    return { role: h.role, content: h.content } as ChatCompletionMessageParam;
  });

  // Legacy AgentOptions shape mirrors runAgentTurn's request shape, but
  // userMessage/history are passed positionally — keep this thin.
  const options: AgentOptions = {
    apiKey: req.apiKey,
    model: req.model,
    provider: "openai",
    systemPrompt: req.systemPrompt,
    tools,
    security: req.security,
    maxIterations: req.maxIterations,
    temperature: req.temperature,
    onEvent: req.onEvent,
    sessionId: req.sessionId,
  };

  const startedAt = Date.now();
  let turn;
  let iterations = 0;
  try {
    turn = await runStandardAgent(fixture.input.userMessage, history, options);
  } finally {
    iterations = getReplayIteration();
    setRegistryOverride(null);
    resetReplayState();
  }
  const durationMs = Date.now() - startedAt;

  return {
    variant: "legacy",
    turn,
    toolCallsObserved: toolObserved,
    events: observed.events,
    durationMs,
    iterations,
    assertionFailure: null,
  };
}

/**
 * Run one fixture through BOTH the legacy and unified loops, diff the
 * outputs, return a ParityResult.
 *
 * The diff is intentionally narrow: we compare the stable contract
 * (stopReason, tool calls invoked, final assistant text) — not every
 * SSE event, since the two loops emit slightly different telemetry
 * shapes (timing, progress events) that don't affect chat correctness.
 * Add more dimensions as real parity gaps surface.
 */
export async function runParityFixture(fixture: Fixture): Promise<ParityResult> {
  const legacy = await runLegacyFixture(fixture);
  const unified = await runFixture(fixture);

  const diffs: string[] = [];

  if (legacy.turn.stopReason !== unified.turn.stopReason) {
    diffs.push(`stopReason: legacy="${legacy.turn.stopReason}" unified="${unified.turn.stopReason}"`);
  }

  if (legacy.toolCallsObserved.length !== unified.toolCallsObserved.length) {
    diffs.push(`toolCallsCount: legacy=${legacy.toolCallsObserved.length} unified=${unified.toolCallsObserved.length}`);
  }

  const legacyToolNames = legacy.toolCallsObserved.map(t => t.name).sort();
  const unifiedToolNames = unified.toolCallsObserved.map(t => t.name).sort();
  if (legacyToolNames.join("|") !== unifiedToolNames.join("|")) {
    diffs.push(`toolNames: legacy=[${legacyToolNames.join(",")}] unified=[${unifiedToolNames.join(",")}]`);
  }

  const legacyText = lastAssistantText(legacy.turn.messages);
  const unifiedText = lastAssistantText(unified.turn.messages);
  if (legacyText !== unifiedText) {
    diffs.push(`assistantText: legacy="${legacyText.slice(0, 120)}" unified="${unifiedText.slice(0, 120)}"`);
  }

  const pass =
    diffs.length === 0 &&
    legacy.assertionFailure === null &&
    unified.assertionFailure === null;

  return { fixtureName: fixture.name, legacy, unified, diffs, pass };
}
