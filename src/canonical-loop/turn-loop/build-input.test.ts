import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTurnInput, collapseAdjacentUserMessages } from "./build-input.js";
import { canonicalToTransport } from "../adapters/canonical-to-transport.js";
import { markConversationCache } from "../../anthropic-client/cache-breakpoints.js";
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

  it("appends the ledger-backed digest as its OWN trailing user message, leaving history untouched", async () => {
    const input = await buildTurnInput(makeOp("interactive"), 1, null);
    const last = input.messages[input.messages.length - 1];
    expect(last.role).toBe("user");
    const text = (last.content as { text: string }).text;
    expect(text).toContain("[SITUATIONAL CONTEXT");
    expect(text).toContain("bash✗");      // the failed action from the ledger
    // The digest is its OWN row now — the real user turn is NOT rewritten.
    expect(text).not.toContain("ship it");
    const prior = input.messages[input.messages.length - 2];
    expect((prior.content as { text: string }).text).toBe("ship it");
    // …and the transport is told the tail is volatile so the cache breakpoint
    // lands beneath it.
    expect(input.ephemeralTailMessages).toBe(1);
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
