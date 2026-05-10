/**
 * Regression: op_submit_async must NOT block on its own host chat_turn op.
 *
 * The bug: chat-runner.ts:308 registers every chat-turn wrapper op into the
 * session's live-ops set BEFORE the model gets its first tool call. When the
 * model then called op_submit_async to legitimately delegate work, the
 * primary live-ops guard saw the host wrapper as a "peer op already running"
 * and returned a BLOCKED tool result containing the host op's id and a
 * literal copy-paste reply template:
 *
 *   Reply to the user in ONE sentence ("op <host id> is already running,
 *   I'll surface results when it completes")
 *
 * The model dutifully copy-pasted the example, narrating a fake delegation
 * that never happened. Repro at sessions/chat-moyzh69p-t0h0c.jsonl:37.
 *
 * Defense in depth covered here:
 *   1. chat_turn ops are excluded from the live-ops set the guard checks.
 *   2. A real peer op IS still blocked (the original guard intent).
 *   3. BLOCKED text contains no literal op-id strings (no `op_<…>_<…>`
 *      patterns the model can lift verbatim).
 *   4. BLOCKED text contains no parenthetical "Reply ... (\"...\")" template.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { opSubmitAsyncTool } from "../src/workers/tools.js";
import { writeOp, newOpId } from "../src/workers/op-store.js";
import { trackOpForSession } from "../src/workers/session-bridge.js";
import type { Op } from "../src/workers/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const createdIds: string[] = [];

const mkOp = (id: string, type: string, status: Op["status"] = "running"): Op => ({
  id,
  type,
  task: type === "chat_turn" ? "yes import them" : `peer task for ${type}`,
  contextPack: {} as Op["contextPack"],
  lane: "interactive",
  retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: "u",
  visibility: "private",
  status,
  createdAt: new Date().toISOString(),
  attemptCount: 0,
});

const persist = (op: Op): Op => {
  writeOp(op);
  createdIds.push(op.id);
  return op;
};

afterEach(() => {
  for (const id of createdIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  createdIds.length = 0;
});

describe("op_submit_async — host-op self-block regression", () => {
  it("does NOT block when only the host chat_turn op is live for the session", async () => {
    const sessionId = `chat-test-${Date.now().toString(36)}`;
    const hostOp = persist(mkOp(newOpId("op_chat_turn"), "chat_turn", "running"));
    trackOpForSession(hostOp.id, sessionId, hostOp.task);

    const result = await opSubmitAsyncTool.execute({
      task: "fetch the weather",
      lane: "interactive",
      _sessionId: sessionId,
    });

    expect(result.content).not.toMatch(/^BLOCKED/);
    expect(result.content).toMatch(/submitted/);
  });

  it("STILL blocks when a real peer op (non chat_turn) is live for the session", async () => {
    const sessionId = `chat-test-${Date.now().toString(36)}-peer`;
    const hostOp = persist(mkOp(newOpId("op_chat_turn"), "chat_turn", "running"));
    const peerOp = persist(mkOp(newOpId("op_freeform"), "freeform", "running"));
    trackOpForSession(hostOp.id, sessionId, hostOp.task);
    trackOpForSession(peerOp.id, sessionId, peerOp.task);

    const result = await opSubmitAsyncTool.execute({
      task: "another delegation",
      lane: "interactive",
      _sessionId: sessionId,
    });

    expect(result.content).toMatch(/^BLOCKED/);
  });

  it("BLOCKED text contains no literal op_<…>_<…> ids the model can parrot", async () => {
    const sessionId = `chat-test-${Date.now().toString(36)}-noid`;
    const hostOp = persist(mkOp(newOpId("op_chat_turn"), "chat_turn", "running"));
    const peerOp = persist(mkOp(newOpId("op_freeform"), "freeform", "running"));
    trackOpForSession(hostOp.id, sessionId, hostOp.task);
    trackOpForSession(peerOp.id, sessionId, peerOp.task);

    const result = await opSubmitAsyncTool.execute({
      task: "another delegation",
      lane: "interactive",
      _sessionId: sessionId,
    });

    expect(result.content).toMatch(/^BLOCKED/);
    // op-id format is op_<prefix-words>_<base36-time 8+>_<base36-rand 6>
    // Tool names like op_submit_async / op_kill don't have the trailing
    // base36 random suffix, so this pattern only matches real ids.
    expect(result.content).not.toMatch(/op_[a-z_]+_[a-z0-9]{6,}_[a-z0-9]{6}/i);
    // Also: the actual peer op id (we know what we registered) must not appear.
    expect(result.content).not.toContain(peerOp.id);
  });

  it("BLOCKED result attaches a tool_chip metadata carrying the peer op id out-of-band", async () => {
    const sessionId = `chat-test-${Date.now().toString(36)}-chip`;
    const hostOp = persist(mkOp(newOpId("op_chat_turn"), "chat_turn", "running"));
    const peerOp = persist(mkOp(newOpId("op_freeform"), "freeform", "running"));
    trackOpForSession(hostOp.id, sessionId, hostOp.task);
    trackOpForSession(peerOp.id, sessionId, peerOp.task);

    const result = await opSubmitAsyncTool.execute({
      task: "another delegation",
      lane: "interactive",
      _sessionId: sessionId,
    });

    // The chip is the structural carrier for the op id — the executor
    // emits a tool_chip ServerEvent with this payload, the chat UI
    // renders it as a kill-button chip on the tool card. The model
    // never sees the chip (only the cleaned `content`), so it can't
    // parrot the id back as a fake delegation message.
    const chip = (result.metadata as { chip?: { kind: string; opId?: string; actions?: Array<{ tool: string; args?: { op_id?: string } }> } } | undefined)?.chip;
    expect(chip).toBeDefined();
    expect(chip?.kind).toBe("blocked-by-op");
    expect(chip?.opId).toBe(peerOp.id);
    // Kill action is wired with the peer op id so the UI button calls
    // /api/op/kill with the right target.
    expect(chip?.actions?.[0]?.tool).toBe("op_kill");
    expect(chip?.actions?.[0]?.args?.op_id).toBe(peerOp.id);
  });

  it("BLOCKED text contains no parenthetical reply template the model can copy-paste", async () => {
    const sessionId = `chat-test-${Date.now().toString(36)}-tpl`;
    const hostOp = persist(mkOp(newOpId("op_chat_turn"), "chat_turn", "running"));
    const peerOp = persist(mkOp(newOpId("op_freeform"), "freeform", "running"));
    trackOpForSession(hostOp.id, sessionId, hostOp.task);
    trackOpForSession(peerOp.id, sessionId, peerOp.task);

    const result = await opSubmitAsyncTool.execute({
      task: "another delegation",
      lane: "interactive",
      _sessionId: sessionId,
    });

    expect(result.content).not.toMatch(/Reply.*\(".+"\)/);
    expect(result.content).not.toMatch(/already running, I'll surface results/);
  });
});
