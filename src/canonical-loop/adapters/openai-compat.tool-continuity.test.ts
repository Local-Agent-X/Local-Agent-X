// Tool continuity across a multi-step tool turn. Incident 2026-09-08:
// muse-glimmer:30b on a MEASURED 65,536-token window with a ~13k-token tool
// manifest. History grew until system + tools + messages no longer fit; the
// adapter's preflight returned "fits_without_tools" and the adapter sent that
// step with `tools: []`, so the model emitted its next tool call as prose.
//
// Two fixes, two seams, pinned here as one invariant: a tool loop never sends
// a step without the tools it started with, and the manifest is reserved
// from the history budget for EVERY model so history is compacted before the
// manifest stops fitting.
//
// Which pre-fix line each assertion catches:
//   Part A — openai-compat.ts (pre a7da547d) `else if (fit.verdict ===
//     "fits_without_tools") { req.tools = []; delete req.toolChoice; }`.
//     Old and new agree on the boundary (system+tools+messages > budget while
//     system+messages still fits); they differ on what happens there. Old:
//     streamOnce is called with an empty tool list. New: refused before any
//     send. So every assertion that "streamOnce was not called" / "every
//     streamOnce call carries the full manifest" on a request in that zone
//     goes red on the old branch. `delete req.toolChoice` sits inside the
//     same branch and is caught transitively — it cannot be observed on its
//     own, because a request in that zone is never sent by the new code.
//   Part B — build-input.ts (pre-fix) `&& isAnthropicModel(model)` on the
//     baselineTokens expression, and chat-runner/runtime-registration.ts's
//     `if (isAnthropicModel(...))` around registerOpBaselineTokens. With the
//     gate, a local model's compaction status was computed with baseline 0.
//   Guardrail only (does NOT fail on the old code): the floor-provenance
//     bypass case. The old code had the same bypass ahead of the strip
//     branch; the case is here so the fix is shown not to have over-corrected
//     into refusing on a guessed window.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./openai-compat/stream-once.js", () => ({
  streamOnce: vi.fn(),
  applyToolCallTextFallback: vi.fn(),
}));
// Partial: the adapter's preflight reads resolveContextWindow (mocked so the
// window's PROVENANCE is under test control); compaction's window lookup
// must follow the same mock so Part B sizes against the incident's 65,536.
vi.mock("../../context-manager/model-windows.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context-manager/model-windows.js")>();
  const resolveContextWindow = vi.fn();
  return {
    ...actual,
    resolveContextWindow,
    lookupContextWindow: (model: string) => resolveContextWindow(model).tokens,
  };
});
vi.mock("../../providers/types.js", () => ({
  markNoToolSupport: vi.fn(),
}));
// Loopback baseURLs trigger live tool-capability evidence after a turn; a
// unit test must never send a probe fetch (see openai-compat.tool-verify.test.ts).
vi.mock("../../providers/tool-capability-probe.js", () => ({
  maybeVerifyToolSupport: vi.fn(),
  noteLiveToolCallEvidence: vi.fn(),
}));
// Spies, not replacements: Part B needs the real compaction pass and the real
// status math — it only needs to SEE what reached them.
vi.mock("../turn-loop/compact-history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../turn-loop/compact-history.js")>();
  return { ...actual, compactHistory: vi.fn(actual.compactHistory) };
});
vi.mock("../../context-manager/status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context-manager/status.js")>();
  return { ...actual, getContextStatus: vi.fn(actual.getContextStatus) };
});

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import { canonicalToChatParam } from "./openai-compat/canonical-to-chat-param.js";
import { resolveContextWindow } from "../../context-manager/model-windows.js";
import { markNoToolSupport } from "../../providers/types.js";
import { OUTPUT_RESERVE_TOKENS, toolManifestTokens } from "../../context-manager/request-fit.js";
import { estimateTokens, totalTokens } from "../../context-manager/token-estimation.js";
import { getContextStatus } from "../../context-manager/status.js";
import { buildTurnInput } from "../turn-loop/build-input.js";
import { compactHistory } from "../turn-loop/compact-history.js";
import { registerOpBaselineTokens, unregisterOpBaselineTokens } from "../runtime.js";
import { appendOpMessage } from "../store.js";
import { opDir } from "../../ops/event-log.js";
import type { Op } from "../../ops/types.js";
import type { TurnInput, AdapterReport } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const mockStream = vi.mocked(streamOnce);
const mockWindow = vi.mocked(resolveContextWindow);

const MODEL = "muse-glimmer:30b";
const WINDOW = 65_536;
const BUDGET = WINDOW - OUTPUT_RESERVE_TOKENS;
const SYSTEM_PROMPT = "s".repeat(500 * 3.5); // ~500 tokens

/** A window we MEASURED off the live runtime — the preflight may act on it. */
function probed(tokens: number) {
  mockWindow.mockReturnValue({ tokens, provenance: "probed" as const });
}
/** The unloaded-model placeholder — a guess, never grounds for refusal. */
function floor() {
  mockWindow.mockReturnValue({ tokens: 8_192, provenance: "floor" as const });
}

/** ~13k tokens of tool schemas, as one manifest of 40 mid-sized tools. */
function incidentManifest(): TurnInput["tools"] {
  return Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${String(i).padStart(2, "0")}`,
    description: "d".repeat(1_050),
    inputSchema: { type: "object" },
  }));
}

/**
 * A tool-loop history of at least `targetTokens` (as the adapter's own
 * estimator will count it): one user ask, then assistant tool-call /
 * tool_result pairs with ~2k-token results until the target is met.
 */
function historyOfTokens(targetTokens: number): CanonicalMessage[] {
  const out: CanonicalMessage[] = [{ messageId: "u-0", role: "user", content: { text: "help" } }];
  let i = 0;
  while (totalTokens(canonicalToChatParam(out, undefined)) < targetTokens) {
    out.push(
      {
        messageId: `a-${i}`, role: "assistant",
        content: { text: "", toolCalls: [{ id: `tc-${i}`, name: "read_file", arguments: `{"path":"f${i}.ts"}` }] },
      },
      {
        messageId: `r-${i}`, role: "tool_result",
        content: { toolCallId: `tc-${i}`, result: "x".repeat(2_000 * 3.5), status: "ok" },
      },
    );
    i++;
  }
  return out;
}

function toolCallResult(id: string): StreamOnceResult {
  return {
    assembledText: "",
    assembledThinking: "",
    pendingToolCalls: [{ id, name: "tool_00", arguments: "{}" }],
    firstError: null,
    providerStop: "tool_calls",
    usagePromptTokens: 10,
    usageCompletionTokens: 5,
    interruptedByInject: false,
  };
}

function finalResult(): StreamOnceResult {
  return { ...toolCallResult("unused"), pendingToolCalls: [], assembledText: "done.", providerStop: "stop" };
}

function makeAdapter(opts: { requireToolOnFirstTurn?: boolean } = {}) {
  return createOpenAICompatAdapter({
    model: MODEL,
    baseURL: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    systemPrompt: SYSTEM_PROMPT,
    ...opts,
  });
}

/** The size components the preflight sees for this composed request. */
function sizeOf(messages: CanonicalMessage[], tools: TurnInput["tools"]) {
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description ?? "", parameters: { type: "object" } }));
  return {
    system: estimateTokens(SYSTEM_PROMPT),
    tools: toolManifestTokens(toolDefs),
    messages: totalTokens(canonicalToChatParam(messages, undefined, new Set(tools.map(t => t.name)))),
  };
}

/**
 * Prove the request sits in the OLD strip zone, not the old too_big zone:
 * without the manifest it fits, with it it does not. This is the only
 * region where the old and new adapters disagree, so an assertion here is
 * the only kind that can go red on the old code.
 */
function expectOldStripZone(messages: CanonicalMessage[], tools: TurnInput["tools"]): void {
  const s = sizeOf(messages, tools);
  expect(s.tools).toBeGreaterThanOrEqual(12_500);
  expect(s.tools).toBeLessThanOrEqual(13_500);
  expect(s.system + s.messages).toBeLessThanOrEqual(BUDGET);
  expect(s.system + s.tools + s.messages).toBeGreaterThan(BUDGET);
}

/** The per-call invariant: full manifest, same names, toolChoice as derived. */
function expectFullManifest(tools: TurnInput["tools"], expectedToolChoice: "required" | undefined): void {
  expect(mockStream.mock.calls.length).toBeGreaterThan(0);
  for (const [sent] of mockStream.mock.calls) {
    expect(sent.tools).toHaveLength(tools.length);
    expect(sent.tools.map(t => t.name)).toEqual(tools.map(t => t.name));
  }
  const first = mockStream.mock.calls[0][0];
  expect(first.toolChoice).toBe(expectedToolChoice);
}

function finalizedMessage(reports: AdapterReport[]): CanonicalMessage {
  const r = reports.find(x => x.kind === "message_finalized");
  expect(r).toBeDefined();
  if (!r || r.kind !== "message_finalized") throw new Error("no finalized message");
  return r.message;
}

function errorReport(reports: AdapterReport[]) {
  const r = reports.find(x => x.kind === "error");
  expect(r).toBeDefined();
  if (!r || r.kind !== "error") throw new Error("no error report");
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openai-compat tool continuity — a tool loop never sends a step without its tools", () => {
  it("regression: carries the full manifest on every step of a 65k-window tool turn, then REFUSES the step that stops fitting instead of stripping", async () => {
    probed(WINDOW);
    const tools = incidentManifest();
    const adapter = makeAdapter({ requireToolOnFirstTurn: true });
    // History sized so three steps fit and the fourth crosses the boundary.
    let messages = historyOfTokens(49_000);
    const opId = "op-continuity";

    // Step 1 (turn 0): the model calls a tool. Turn-0 forcing is on, so the
    // derived toolChoice is "required" — the old strip branch deleted it.
    mockStream.mockResolvedValueOnce(toolCallResult("c1"));
    let reports: AdapterReport[] = [];
    let result = await adapter.runTurn({ opId, turnIdx: 0, messages, tools }, r => reports.push(r));
    expect(result.terminalReason).toBeUndefined(); // pending tool call
    messages = [
      ...messages,
      finalizedMessage(reports),
      { messageId: "res-1", role: "tool_result", content: { toolCallId: "c1", result: "ok: " + "y".repeat(300), status: "ok" } },
    ];

    // Step 2 (turn 1): tool result in, another tool call out.
    mockStream.mockResolvedValueOnce(toolCallResult("c2"));
    reports = [];
    result = await adapter.runTurn({ opId, turnIdx: 1, messages, tools }, r => reports.push(r));
    expect(result.terminalReason).toBeUndefined();
    messages = [
      ...messages,
      finalizedMessage(reports),
      { messageId: "res-2", role: "tool_result", content: { toolCallId: "c2", result: "ok: " + "y".repeat(300), status: "ok" } },
    ];

    // Step 3 (turn 2): final prose.
    mockStream.mockResolvedValueOnce(finalResult());
    reports = [];
    result = await adapter.runTurn({ opId, turnIdx: 2, messages, tools }, r => reports.push(r));
    expect(result.terminalReason).toBe("done");
    expect(reports.filter(r => r.kind === "error")).toHaveLength(0);

    // Three sends so far, every one with the whole manifest.
    expect(mockStream).toHaveBeenCalledTimes(3);
    expectFullManifest(tools, "required");
    expect(mockStream.mock.calls[1][0].toolChoice).toBeUndefined();
    expect(mockStream.mock.calls[2][0].toolChoice).toBeUndefined();

    // Step 4 (turn 3): the user pastes ~4k tokens. System + messages still
    // fit; system + tools + messages do not. The old adapter sent this step
    // with tools: [] — the exact step where muse-glimmer narrated its call.
    messages = [
      ...messages,
      finalizedMessage(reports),
      { messageId: "u-1", role: "user", content: { text: "p".repeat(4_000 * 3.5) } },
    ];
    expectOldStripZone(messages, tools);
    reports = [];
    result = await adapter.runTurn({ opId, turnIdx: 3, messages, tools }, r => reports.push(r));

    expect(mockStream).toHaveBeenCalledTimes(3); // old: 4, the 4th with tools: []
    expect(result.terminalReason).toBe("error");
    const err = errorReport(reports);
    expect(err.code).toBe("context_window_exceeded");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("65,536");
    expect(err.message).toMatch(/tools ~1[23],\d{3}/);
    // Re-check the whole sequence: nothing was ever sent tool-less.
    expectFullManifest(tools, "required");
    // The caller's tool list was never reshaped, and a window problem is not
    // a capability problem — the permanent no-tool latch must not fire.
    expect(tools).toHaveLength(40);
    expect(vi.mocked(markNoToolSupport)).not.toHaveBeenCalled();
  });

  it("refuses BEFORE streamOnce when ~60k tokens of history plus the manifest cannot fit — never a tool-less send", async () => {
    probed(WINDOW);
    const tools = incidentManifest();
    const messages = historyOfTokens(60_000);
    expectOldStripZone(messages, tools);
    const adapter = makeAdapter();
    const reports: AdapterReport[] = [];

    const result = await adapter.runTurn({ opId: "op-60k", turnIdx: 1, messages, tools }, r => reports.push(r));

    expect(mockStream).not.toHaveBeenCalled();
    expect(result.terminalReason).toBe("error");
    const err = errorReport(reports);
    expect(err.code).toBe("context_window_exceeded");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("65,536");
    expect(err.message).toMatch(/system prompt ~[\d,]+/);
    expect(err.message).toMatch(/tools ~1[23],\d{3}/);
    expect(err.message).toMatch(/messages ~6\d,\d{3}/);
    expect(tools).toHaveLength(40);
    expect(vi.mocked(markNoToolSupport)).not.toHaveBeenCalled();
  });

  // Guardrail, not a regression catcher: the old adapter had this same bypass
  // ahead of its strip branch. It is here to show the fix did not over-correct
  // into refusing on a guessed window (the 2026-07-15 deadlock).
  it("still sends — with the full manifest — when only a floor window says it does not fit", async () => {
    floor();
    const tools = incidentManifest();
    const messages = historyOfTokens(60_000);
    mockStream.mockResolvedValueOnce(finalResult());
    const adapter = makeAdapter();
    const reports: AdapterReport[] = [];

    const result = await adapter.runTurn({ opId: "op-floor", turnIdx: 1, messages, tools }, r => reports.push(r));

    expect(mockStream).toHaveBeenCalledTimes(1);
    expectFullManifest(tools, undefined);
    expect(result.terminalReason).toBe("done");
    expect(reports.filter(r => r.kind === "error")).toHaveLength(0);
  });
});

// build-input.test.ts ("baseline reservation reaches compaction for every
// model") already pins that a registered 13,000 reaches compactHistory for
// muse-glimmer:30b. This is the thinner seam-level check with the incident's
// window: the registry → build-input path yields a non-zero baseline for a
// non-Anthropic chat_turn op, and the compaction STATUS is computed with it
// against the measured 65,536 window — so history is sized against the
// budget the manifest leaves, not the raw window.
describe("openai-compat tool continuity — the manifest is reserved from the history budget for a local model", () => {
  let dir: string;
  let prevEnv: string | undefined;
  let prevKill: string | undefined;
  const opId = "op_tool_continuity_bl";
  const mockCompact = vi.mocked(compactHistory);
  const mockStatus = vi.mocked(getContextStatus);

  beforeEach(() => {
    prevEnv = process.env.LAX_DATA_DIR;
    prevKill = process.env.LAX_CONTEXT_BASELINE;
    delete process.env.LAX_CONTEXT_BASELINE;
    dir = mkdtempSync(join(tmpdir(), "lax-tool-continuity-"));
    process.env.LAX_DATA_DIR = dir;
    appendOpMessage({
      messageId: "u-0", opId, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "help" }, createdAt: "2026-09-08T10:00:00.000Z",
    });
    probed(WINDOW);
  });

  afterEach(() => {
    unregisterOpBaselineTokens(opId);
    try { rmSync(opDir(opId), { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prevEnv;
    if (prevKill === undefined) delete process.env.LAX_CONTEXT_BASELINE;
    else process.env.LAX_CONTEXT_BASELINE = prevKill;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("a registered ~13k baseline reaches the status math for muse-glimmer:30b against a 65,536 window", async () => {
    registerOpBaselineTokens(opId, 13_000);
    const op = { id: opId, type: "chat_turn", model: MODEL, task: "help", lane: "interactive" } as unknown as Op;

    await buildTurnInput(op, 1, null);

    // Registry → build-input: non-zero for a non-Anthropic model.
    expect(mockCompact).toHaveBeenCalledTimes(1);
    const [, compactModel, , compactOpId, baseline] = mockCompact.mock.calls[0];
    expect(compactModel).toBe(MODEL);
    expect(compactOpId).toBe(opId);
    expect(baseline).toBe(13_000);

    // build-input → compaction → status: the number is USED, against the
    // incident window. Old gate: baselineTokens 0, usedTokens ≈ the one row.
    expect(mockStatus).toHaveBeenCalledTimes(1);
    const [, statusModel, , , statusBaseline] = mockStatus.mock.calls[0];
    expect(statusModel).toBe(MODEL);
    expect(statusBaseline).toBe(13_000);
    const status = mockStatus.mock.results[0].value;
    expect(status.maxTokens).toBe(WINDOW);
    expect(status.usedTokens).toBeGreaterThanOrEqual(13_000);
    expect(status.usedTokens).toBeLessThan(13_000 + 1_000); // one tiny row + the baseline, nothing else
  });
});
