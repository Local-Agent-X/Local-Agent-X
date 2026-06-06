import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTurnInput, collapseAdjacentUserMessages } from "./build-input.js";
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

  it("prepends the ledger-backed digest to the last user message on interactive ops", () => {
    const input = buildTurnInput(makeOp("interactive"), 1, null);
    const last = input.messages[input.messages.length - 1];
    expect(last.role).toBe("user");
    const text = (last.content as { text: string }).text;
    expect(text).toContain("[SITUATIONAL CONTEXT");
    expect(text).toContain("bash✗");      // the failed action from the ledger
    expect(text).toContain("ship it");    // original user text preserved, after the digest
    expect(text.indexOf("[SITUATIONAL CONTEXT")).toBeLessThan(text.indexOf("ship it"));
  });

  it("does NOT inject on non-interactive lanes", () => {
    const input = buildTurnInput(makeOp("background"), 1, null);
    const last = input.messages[input.messages.length - 1];
    const text = (last.content as { text: string }).text;
    expect(text).not.toContain("[SITUATIONAL CONTEXT");
    expect(text).toBe("ship it");
  });
});
