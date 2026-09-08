import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spy on compactHistory WITHOUT replacing it: the situational-awareness and
// step-effort cases below need the real compaction pass, the baseline cases
// need to see what buildTurnInput handed it.
vi.mock("./compact-history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compact-history.js")>();
  return { ...actual, compactHistory: vi.fn(actual.compactHistory) };
});
// Same shape for the window resolution: real by default, pinned per test to
// a "floor" (unloaded local model) or "probed" (measured) window. Both the
// provenance read in build-input and the number read by effectiveContextWindow
// go through this module, so the real compaction pass sizes against the pin.
vi.mock("../../context-manager/model-windows.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context-manager/model-windows.js")>();
  return {
    ...actual,
    resolveContextWindow: vi.fn(actual.resolveContextWindow),
    lookupContextWindow: vi.fn(actual.lookupContextWindow),
  };
});
// Compaction must never reach a real summarizer from here: if a baseline case
// regresses into compacting, fail on the spy, not on a hung LLM call.
vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn(async () => "SUMMARY") }));

import { buildTurnInput, collapseAdjacentUserMessages } from "./build-input.js";
import { compactHistory } from "./compact-history.js";
import { lookupContextWindow, resolveContextWindow } from "../../context-manager/model-windows.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import { registerOpBaselineTokens, unregisterOpBaselineTokens } from "../runtime.js";
import { canonicalToTransport } from "../adapters/canonical-to-transport.js";
import { markConversationCache } from "../../anthropic-client/cache-breakpoints.js";
import { toGeminiContents } from "../adapters/gemini-native-transport.js";
import { convertMessagesToInput } from "../../codex-message-convert.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { CanonicalMessage } from "../contract-types.js";
import { appendOpMessage } from "../store.js";
import { trackOpForSession, releaseOpFromSession } from "../../ops/session-bridge.js";
import { appendActionLedger } from "../../ops/action-ledger.js";
import { opDir } from "../../ops/event-log.js";
import type { Op } from "../../ops/types.js";

const user = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text } });
const assistant = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "assistant", content: { text } });

describe("collapseAdjacentUserMessages", () => {
  it("merges a rapid double-send into one user turn", () => {
    const out = collapseAdjacentUserMessages([
      user("a", "I want to start a company"),
      user("b", "doing active shooter training"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect((out[0].content as { text: string }).text).toBe(
      "I want to start a company\n\ndoing active shooter training",
    );
  });

  it("merges the question + nudge left adjacent after a retracted hallucination", () => {
    // user question, assistant lie dropped, nudge appended as a user message
    const out = collapseAdjacentUserMessages([
      user("q", "I want to start a company"),
      user("n", "You did NOT spawn a worker. Answer the user directly."),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0].content as { text: string }).text).toContain("start a company");
    expect((out[0].content as { text: string }).text).toContain("did NOT spawn");
  });

  it("preserves alternation — does not touch user/assistant pairs", () => {
    const msgs = [user("a", "hi"), assistant("b", "hello"), user("c", "bye")];
    expect(collapseAdjacentUserMessages(msgs)).toEqual(msgs);
  });

  it("leaves image-bearing user rows standalone", () => {
    const withImg: CanonicalMessage = {
      messageId: "img",
      role: "user",
      content: { text: "look at this", images: [{ url: "data:...", name: "x.png" }] },
    };
    const out = collapseAdjacentUserMessages([user("a", "first"), withImg]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(withImg);
  });

  it("collapses a run of three plain user messages", () => {
    const out = collapseAdjacentUserMessages([user("a", "one"), user("b", "two"), user("c", "three")]);
    expect(out).toHaveLength(1);
    expect((out[0].content as { text: string }).text).toBe("one\n\ntwo\n\nthree");
  });

  it("is a no-op on an empty history", () => {
    expect(collapseAdjacentUserMessages([])).toEqual([]);
  });
});

describe("buildTurnInput — situational-awareness wiring", () => {
  let dir: string;
  let prevEnv: string | undefined;
  let opId: string;
  let seq = 0;
  const sessionId = "sess-bi-test";

  function makeOp(lane: string): Op {
    return { id: opId, type: "chat_turn", task: "deploy the site", lane } as unknown as Op;
  }

  beforeEach(() => {
    prevEnv = process.env.LAX_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), "lax-buildinput-"));
    process.env.LAX_DATA_DIR = dir;
    // Unique opId per test: op_messages live under a module-load-fixed OPS_BASE
    // (event-log.ts) that does NOT honor LAX_DATA_DIR, so a shared id would
    // bleed rows across tests. Cleaned in afterEach.
    opId = `op_bi_test_${seq++}`;
    trackOpForSession(opId, sessionId, "deploy the site");
    appendOpMessage({
      messageId: "um-0", opId, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "ship it" }, createdAt: "2026-06-06T10:00:00.000Z",
    });
    // A prior committed action in this session — what the digest should surface.
    appendActionLedger({
      ts: "2026-06-06T10:00:30.000Z", sessionId, opId, opType: "chat_turn",
      turnIdx: 0, task: "deploy the site",
      actions: [{ tool: "bash", status: "error" }], terminalReason: "error",
    });
  });

  afterEach(() => {
    releaseOpFromSession(opId);
    try { rmSync(opDir(opId), { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prevEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // The assistant reply the seed user row is missing, so a continuation turn
  // does NOT end on a user row — the ordinary mid-conversation shape.
  function appendAssistantReply(turn = 0): void {
    appendOpMessage({
      messageId: `am-${turn}`, opId, turnIdx: turn, seqInTurn: 1,
      role: "assistant", content: { text: "on it" },
      createdAt: `2026-06-06T10:0${turn + 1}:00.000Z`,
    });
  }

  it("appends the ledger-backed digest as its OWN trailing user message, leaving history untouched", async () => {
    appendAssistantReply();
    const input = await buildTurnInput(makeOp("interactive"), 1, null);
    const last = input.messages[input.messages.length - 1];
    expect(last.role).toBe("user");
    const text = (last.content as { text: string }).text;
    expect(text).toContain("[SITUATIONAL CONTEXT");
    expect(text).toContain("bash✗");      // the failed action from the ledger
    // The digest is its OWN row here — the real user turn is NOT rewritten.
    expect(text).not.toContain("ship it");
    const prior = input.messages[input.messages.length - 2];
    expect(prior.role).toBe("assistant");
    expect(input.messages[0].content).toEqual({ text: "ship it" });
    // …and the transport is told the tail is volatile so the cache breakpoint
    // lands beneath it.
    expect(input.ephemeralTailMessages).toBe(1);
  });

  // F5 — when the history ALREADY ends on a user row (a fresh user turn, a
  // nudge), a bare append would hand codex/gemini `[user, user]`, which is the
  // shape this repo documents as making Codex return EMPTY responses. The
  // digest merges into that row instead. It is still the LAST row, so it is
  // still exactly the volatile row ephemeralTailMessages declares.
  it("merges into a trailing user row instead of emitting two user rows in a row", async () => {
    const input = await buildTurnInput(makeOp("interactive"), 1, null);
    expect(input.messages).toHaveLength(1);
    const text = (input.messages[0].content as { text: string }).text;
    expect(text).toContain("ship it");
    expect(text).toContain("[SITUATIONAL CONTEXT");
    expect(input.ephemeralTailMessages).toBe(1);

    // No transport sees a user-only run — checked on the two that break on it.
    const wire = canonicalToTransport(input.messages, input.pendingRedirect);
    expect(wire.map(m => m.role)).toEqual(["user"]);

    // Gemini: contents roles (its transport's own converter).
    const gemini = toGeminiContents(wire);
    expect(gemini.map(c => c.role)).toEqual(["user"]);

    // Codex: Responses-API input items, via the same map codex-transport does.
    const codexItems = convertMessagesToInput(
      wire.map(m => ({ role: m.role, content: m.content } as ChatCompletionMessageParam)),
    ) as Array<{ type?: string; role?: string }>;
    const userRun = codexItems.filter(i => i.type === "message" && i.role === "user");
    expect(userRun).toHaveLength(1);
  });

  it("injects on the long autonomous lanes (agent/background) — they drift too", async () => {
    for (const lane of ["agent", "background"] as const) {
      const input = await buildTurnInput(makeOp(lane), 1, null);
      const last = input.messages[input.messages.length - 1];
      const text = (last.content as { text: string }).text;
      expect(text, lane).toContain("[SITUATIONAL CONTEXT");
      expect(input.ephemeralTailMessages, lane).toBe(1);
    }
  });

  it("does NOT inject on the build lane (soak-sensitive, has its own gates)", async () => {
    const input = await buildTurnInput(makeOp("build"), 1, null);
    const last = input.messages[input.messages.length - 1];
    const text = (last.content as { text: string }).text;
    expect(text).not.toContain("[SITUATIONAL CONTEXT");
    expect(text).toBe("ship it");
    expect(input.ephemeralTailMessages).toBeUndefined();
  });

  // ── The load-bearing property ────────────────────────────────────────────
  //
  // The Anthropic message-tier prompt cache only pays when turn N's message
  // array is a strict PREFIX of turn N+1's, up to the breakpoint. The digest
  // is regenerated every turn, so wherever it lands it MUST land below the
  // breakpoint — i.e. only in the ephemeral tail.
  //
  // Mutation check: restore prependDigestToLastUser (fold the digest into the
  // last user row) and this test goes red — the digest's per-turn bytes then
  // sit at an EARLY index, so turn 1's array is not a prefix of turn 2's.
  it("keeps turn N's messages a strict prefix of turn N+1's up to the cache breakpoint", async () => {
    // Turn 1 mid-conversation: history does NOT end on a user row, so the
    // digest is its own trailing row and the rows above it are the cached
    // region under test.
    appendAssistantReply();
    const turn1 = await buildTurnInput(makeOp("interactive"), 1, null);

    // A real continuation: the assistant answered and the user replied. Both
    // rows are persisted, so they belong to the STABLE prefix of turn 2.
    appendOpMessage({
      messageId: "am-1", opId, turnIdx: 1, seqInTurn: 0,
      role: "assistant", content: { text: "on it" }, createdAt: "2026-06-06T10:01:00.000Z",
    });
    appendActionLedger({
      ts: "2026-06-06T10:01:30.000Z", sessionId, opId, opType: "chat_turn",
      turnIdx: 1, task: "deploy the site",
      actions: [{ tool: "read", status: "ok" }], terminalReason: "done",
    });
    const turn2 = await buildTurnInput(makeOp("interactive"), 2, null);

    // The digest genuinely CHANGED between the turns — otherwise this test
    // would pass vacuously even with the old prepend behavior.
    const digest1 = (turn1.messages[turn1.messages.length - 1].content as { text: string }).text;
    const digest2 = (turn2.messages[turn2.messages.length - 1].content as { text: string }).text;
    expect(digest2).not.toBe(digest1);

    // Breakpoint index = last message minus the declared ephemeral tail.
    const bp1 = turn1.messages.length - 1 - (turn1.ephemeralTailMessages ?? 0);
    const bp2 = turn2.messages.length - 1 - (turn2.ephemeralTailMessages ?? 0);
    expect(bp1).toBeGreaterThanOrEqual(0);
    expect(bp2).toBeGreaterThan(bp1); // turn 2 genuinely grew the cached region

    // Everything at or before turn 1's breakpoint must be byte-identical in
    // turn 2 — that IS the cache-prefix property.
    for (let i = 0; i <= bp1; i++) {
      expect(JSON.stringify(turn2.messages[i]), `message ${i} diverged`)
        .toBe(JSON.stringify(turn1.messages[i]));
    }
  });

  // F4 — the classify/append ORDER is load-bearing and was untested through
  // the real builder: classifyStepEffort walks back over the TRAILING
  // tool_result batch (step-effort.ts), so a trailing user row makes
  // `start === messages.length` and every mechanical continuation classifies
  // "standard" instead — silently raising reasoning effort on exactly the
  // steps this hint exists to cheapen. The step-effort unit tests build the
  // input by hand and never see the digest append, so they cannot catch it.
  //
  // Mutation check: move the classifyStepEffort call in build-input.ts below
  // the digest append — this test must go red.
  it("classifies a mechanical continuation BEFORE the digest append hides the batch", async () => {
    appendOpMessage({
      messageId: "am-mech", opId, turnIdx: 1, seqInTurn: 0,
      role: "assistant", content: { text: "", toolCalls: [{ id: "tc-1", name: "read", arguments: "{}" }] },
      createdAt: "2026-06-06T10:01:00.000Z",
    });
    appendOpMessage({
      messageId: "tr-mech", opId, turnIdx: 1, seqInTurn: 1,
      role: "tool_result", content: { toolCallId: "tc-1", result: "file body", status: "ok" },
      createdAt: "2026-06-06T10:01:01.000Z",
    });

    const input = await buildTurnInput(makeOp("interactive"), 2, null);
    // The digest DID fire on this lane (that is the whole point — the trailing
    // user row exists), and the hint survived it.
    const last = input.messages[input.messages.length - 1];
    expect((last.content as { text: string }).text).toContain("[SITUATIONAL CONTEXT");
    expect(input.stepEffortHint).toBe("mechanical");
  });

  // F2 — a redirect turn. The `[REDIRECT]` row is appended by the ADAPTER,
  // below everything buildTurnInput produced (including the digest), so the
  // marked prefix has to account for it. Before the fix the wire tail was
  // [user(digest), user(REDIRECT)] while ephemeralTailMessages said 1, and the
  // cache_control marker landed ON the volatile digest: every redirect turn
  // wrote the whole conversation at 1.25x and could never read it back.
  it("keeps the cache marker off the volatile tail on a redirect turn", async () => {
    const redirect = {
      instructionId: "ri-1",
      text: "actually deploy staging first",
      receivedAt: "2026-06-06T10:02:00.000Z",
    };
    appendAssistantReply(); // mid-conversation: the digest is its own row
    const input = await buildTurnInput(makeOp("interactive"), 1, redirect);
    const wire = canonicalToTransport(input.messages, input.pendingRedirect);

    // One volatile row on the wire: the digest with the redirect folded in.
    const tail = wire[wire.length - 1];
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("[SITUATIONAL CONTEXT");
    expect(tail.content).toContain("[REDIRECT] actually deploy staging first");
    expect(input.ephemeralTailMessages).toBe(1);

    // …and the marker computed from that count lands BELOW it, on a row whose
    // bytes do not change next turn.
    const marked = markConversationCache(
      wire.map(m => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: m.content ?? "" })),
      true,
      input.ephemeralTailMessages,
    );
    const markedIdx = marked.findIndex(m =>
      Array.isArray(m.content) && m.content.some(b => (b as { cache_control?: unknown }).cache_control));
    expect(markedIdx).toBe(marked.length - 2);
    expect(JSON.stringify(marked[markedIdx])).not.toContain("REDIRECT");
    expect(JSON.stringify(marked[markedIdx])).not.toContain("SITUATIONAL CONTEXT");
  });

  it("still delivers the digest to the model (the re-anchoring is not silently dropped)", async () => {
    const input = await buildTurnInput(makeOp("interactive"), 1, null);
    const wire = canonicalToTransport(input.messages, undefined);
    const tail = wire[wire.length - 1];
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("[SITUATIONAL CONTEXT");
    // canonicalToTransport does NOT merge same-role rows, so the digest
    // survives as its own wire message and the tail count stays valid.
    expect(wire).toHaveLength(input.messages.length);
  });
});

describe("buildTurnInput — per-step effort hint", () => {
  let dir: string;
  let prevEnv: string | undefined;
  let opId: string;
  let seq = 0;

  function makeOp(): Op {
    return { id: opId, type: "chat_turn", task: "fix the bug", lane: "build" } as unknown as Op;
  }

  // Seed the rows a real continuation turn replays: user ask, assistant
  // tool-calling row (content.toolCalls — the adapters' finalized shape),
  // then the pending tool_result batch (dispatch-tools.ts commit shape).
  function seedContinuation(toolName: string, status: string): void {
    appendOpMessage({
      messageId: "u-0", opId, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "fix the bug" }, createdAt: "2026-07-27T10:00:00.000Z",
    });
    appendOpMessage({
      messageId: "a-0", opId, turnIdx: 0, seqInTurn: 1,
      role: "assistant",
      content: { text: "", toolCalls: [{ id: "tc-1", name: toolName, arguments: "{}" }] },
      createdAt: "2026-07-27T10:00:01.000Z",
    });
    appendOpMessage({
      messageId: "tr-0", opId, turnIdx: 0, seqInTurn: 2,
      role: "tool_result",
      content: { toolCallId: "tc-1", result: "file contents", status },
      createdAt: "2026-07-27T10:00:02.000Z",
    });
  }

  beforeEach(() => {
    prevEnv = process.env.LAX_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), "lax-buildinput-se-"));
    process.env.LAX_DATA_DIR = dir;
    opId = `op_bi_se_test_${seq++}`;
  });

  afterEach(() => {
    try { rmSync(opDir(opId), { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prevEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("sets stepEffortHint on a mechanical continuation (all-ok file-mechanics batch)", async () => {
    seedContinuation("read", "ok");
    const input = await buildTurnInput(makeOp(), 1, null);
    expect(input.stepEffortHint).toBe("mechanical");
  });

  it("omits stepEffortHint when the trailing batch has a non-mechanical tool", async () => {
    seedContinuation("bash", "ok");
    const input = await buildTurnInput(makeOp(), 1, null);
    expect(input.stepEffortHint).toBeUndefined();
  });

  it("omits stepEffortHint when the mechanical tool failed", async () => {
    seedContinuation("read", "error");
    const input = await buildTurnInput(makeOp(), 1, null);
    expect(input.stepEffortHint).toBeUndefined();
  });

  it("a pending redirect suppresses the hint even over a mechanical batch — the re-plan step keeps full effort", async () => {
    // Redirects reach the model OUTSIDE `messages` (adapters append the
    // "[REDIRECT] …" user row at request build), so the trailing-batch rule
    // alone would misclassify this step as mechanical.
    seedContinuation("read", "ok");
    const input = await buildTurnInput(makeOp(), 1, {
      instructionId: "ri-1", text: "stop — do X instead", receivedAt: "2026-07-27T10:00:03.000Z",
    });
    expect(input.pendingRedirect?.text).toBe("stop — do X instead"); // redirect still flows to the adapter
    expect(input.stepEffortHint).toBeUndefined();
  });
});

// Fixed overhead (system prompt + tool manifest) is reserved for EVERY model.
// Incident 2026-09-08: a local 65k-window model sized history against the raw
// window, history grew until the ~13k-token manifest no longer fit, and the
// adapter stripped tools mid-turn. Behavior under test: whatever the op
// registered at submit reaches compactHistory as its baselineTokens argument
// regardless of provider. (compactHistory's own handling of that number is
// covered by compact-history.golden.test.ts.)
describe("buildTurnInput — baseline reservation reaches compaction for every model", () => {
  let dir: string;
  let prevEnv: string | undefined;
  let prevKill: string | undefined;
  let opId: string;
  let seq = 0;
  const mockCompact = vi.mocked(compactHistory);

  function makeOp(model: string, type = "chat_turn"): Op {
    return { id: opId, type, model, task: "help", lane: "interactive" } as unknown as Op;
  }

  function baselinePassedToCompaction(): number {
    expect(mockCompact).toHaveBeenCalledTimes(1);
    const [, , , calledOpId, baseline] = mockCompact.mock.calls[0];
    expect(calledOpId).toBe(opId);
    return baseline ?? 0;
  }

  beforeEach(() => {
    prevEnv = process.env.LAX_DATA_DIR;
    prevKill = process.env.LAX_CONTEXT_BASELINE;
    delete process.env.LAX_CONTEXT_BASELINE;
    dir = mkdtempSync(join(tmpdir(), "lax-buildinput-bl-"));
    process.env.LAX_DATA_DIR = dir;
    opId = `op_bi_bl_test_${seq++}`;
    appendOpMessage({
      messageId: "u-0", opId, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "help" }, createdAt: "2026-09-08T10:00:00.000Z",
    });
    mockCompact.mockClear();
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

  it("a local openai-compat model's registered baseline reaches compactHistory (the incident case)", async () => {
    registerOpBaselineTokens(opId, 13_000);
    await buildTurnInput(makeOp("muse-glimmer:30b"), 1, null);
    expect(baselinePassedToCompaction()).toBe(13_000);
  });

  it("an Anthropic model's registered baseline still reaches compactHistory", async () => {
    registerOpBaselineTokens(opId, 147_000);
    await buildTurnInput(makeOp("claude-sonnet-4-6"), 1, null);
    expect(baselinePassedToCompaction()).toBe(147_000);
  });

  it("LAX_CONTEXT_BASELINE=0 disables the reservation for a local model too", async () => {
    process.env.LAX_CONTEXT_BASELINE = "0";
    registerOpBaselineTokens(opId, 13_000);
    await buildTurnInput(makeOp("muse-glimmer:30b"), 1, null);
    expect(baselinePassedToCompaction()).toBe(0);
  });

  it("a non-chat op does not inherit the chat tool surface's baseline", async () => {
    // Both baseline sources describe the interactive-chat surface; a delegated
    // op with a narrower surface must size against its own (unregistered → 0).
    registerOpBaselineTokens(opId, 13_000);
    await buildTurnInput(makeOp("muse-glimmer:30b", "delegated"), 1, null);
    expect(baselinePassedToCompaction()).toBe(0);
  });

  // A placeholder window gets NO reservation. An unloaded local model resolves
  // to the 8,192 "floor" guess; a ~13k baseline against it reads as 160%+ and
  // every step compacts to the aggressive minimum until the next op re-probes
  // the runtime — the user's live question can be summarized away mid
  // tool-loop. Same integer as a genuinely-measured 8k window, which is why
  // the pin is on provenance, never on the number.
  describe("placeholder (floor) window", () => {
    const mockWindow = vi.mocked(resolveContextWindow);
    const mockLookup = vi.mocked(lookupContextWindow);

    function pinWindow(tokens: number, provenance: "floor" | "probed"): void {
      mockWindow.mockReturnValue({ tokens, provenance });
      mockLookup.mockReturnValue(tokens);
    }

    afterEach(async () => {
      // Back to the real resolution — a bare mockReset would leave both
      // returning undefined for whatever runs after this block.
      const actual = await vi.importActual<typeof import("../../context-manager/model-windows.js")>("../../context-manager/model-windows.js");
      mockWindow.mockReset().mockImplementation(actual.resolveContextWindow);
      mockLookup.mockReset().mockImplementation(actual.lookupContextWindow);
      vi.mocked(summarizeOldMessages).mockClear();
    });

    it("floor provenance → compactHistory receives 0, whatever the op registered", async () => {
      pinWindow(8_192, "floor");
      registerOpBaselineTokens(opId, 13_000);
      await buildTurnInput(makeOp("muse-glimmer:30b"), 1, null);
      expect(baselinePassedToCompaction()).toBe(0);
    });

    it("probed provenance → compactHistory receives the registered estimate", async () => {
      pinWindow(65_536, "probed");
      registerOpBaselineTokens(opId, 13_000);
      await buildTurnInput(makeOp("muse-glimmer:30b"), 1, null);
      expect(baselinePassedToCompaction()).toBe(13_000);
    });

    it("guard: a floor window with ≤4 rows is a compaction no-op", async () => {
      pinWindow(8_192, "floor");
      registerOpBaselineTokens(opId, 13_000);
      // Three more tiny rows on top of the seeded user row: 4 rows total.
      appendOpMessage({
        messageId: "a-0", opId, turnIdx: 0, seqInTurn: 1,
        role: "assistant", content: { text: "sure" }, createdAt: "2026-09-08T10:00:01.000Z",
      });
      appendOpMessage({
        messageId: "u-1", opId, turnIdx: 1, seqInTurn: 0,
        role: "user", content: { text: "and then?" }, createdAt: "2026-09-08T10:00:02.000Z",
      });
      appendOpMessage({
        messageId: "a-1", opId, turnIdx: 1, seqInTurn: 1,
        role: "assistant", content: { text: "this" }, createdAt: "2026-09-08T10:00:03.000Z",
      });
      const input = await buildTurnInput(makeOp("muse-glimmer:30b"), 2, null);
      const result = await mockCompact.mock.results[0].value;
      expect(result.compacted).toBe(false);
      expect(input.viewCompacted).toBeUndefined();
      expect(summarizeOldMessages).not.toHaveBeenCalled();
      // Every real row survived — nothing was summarized away.
      expect(input.messages.map(m => m.messageId).slice(0, 4)).toEqual(["u-0", "a-0", "u-1", "a-1"]);
    });
  });
});
