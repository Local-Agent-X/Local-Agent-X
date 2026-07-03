/**
 * Regression: spawn-lineage parent op id (chunk C1).
 *
 * When an op is submitted from inside a chat/voice turn, the new op must record
 * the spawning turn's op id in `Op.parentOpId`, and the canonical-loop observer
 * must carry that id onto the `bg_op_queued` / `bg_op_started` events the UI
 * listens to. This is the data foundation for the later run-lineage tree.
 *
 * Honest boundary encoded here: the parent is recovered from the executor
 * stamped `_sessionId` via the live interactive-host op (chat_turn / voice_turn)
 * for that session. When there is no live host op in the session (e.g. a
 * worker→worker spawn, whose executing op id is not threaded into the tool args
 * at this seam), `parentOpId` is left undefined — strictly optional, absence is
 * a no-op.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { buildOpFromArgs } from "../src/ops/tools/shared.js";
import { writeOp, newOpId } from "../src/ops/op-store.js";
import {
  trackOpForSession,
  setSessionBroadcaster,
} from "../src/ops/session-bridge.js";
import { recordCanonicalEvent } from "../src/canonical-loop/session-bridge-observer.js";
import type { Op } from "../src/ops/types.js";
import type { ServerEvent } from "../src/types.js";
import type { CanonicalEvent } from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const createdIds: string[] = [];

const mkOp = (id: string, type: string, extra: Partial<Op> = {}): Op => ({
  id,
  type,
  task: `task for ${type}`,
  contextPack: {} as Op["contextPack"],
  lane: "interactive",
  retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: "u",
  visibility: "private",
  status: "running",
  createdAt: new Date().toISOString(),
  attemptCount: 0,
  ...extra,
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

describe("op submit — spawn-lineage parentOpId (setter)", () => {
  it("stamps parentOpId = the live chat_turn host op id onto the new op", async () => {
    const sessionId = `chat-lineage-${Date.now().toString(36)}`;
    const hostOp = persist(mkOp(newOpId("op_chat_turn"), "chat_turn"));
    trackOpForSession(hostOp.id, sessionId, hostOp.task);

    const op = await buildOpFromArgs({
      task: "research the weather in NYC",
      lane: "interactive",
      _sessionId: sessionId,
    });

    expect(op.parentOpId).toBe(hostOp.id);
  });

  it("stamps the voice_turn host op too (voice-originated delegation)", async () => {
    const sessionId = `chat-lineage-${Date.now().toString(36)}-v`;
    const hostOp = persist(mkOp(newOpId("op_voice_turn"), "voice_turn"));
    trackOpForSession(hostOp.id, sessionId, hostOp.task);

    const op = await buildOpFromArgs({
      task: "open google for the user",
      lane: "interactive",
      _sessionId: sessionId,
    });

    expect(op.parentOpId).toBe(hostOp.id);
  });

  it("leaves parentOpId undefined when no live host op exists (worker→worker seam)", async () => {
    // A non-host peer op is live, but the executing op's id is not recoverable
    // from _sessionId at this seam — so we honestly leave the field unset rather
    // than mis-attribute the parent to an unrelated peer.
    const sessionId = `chat-lineage-${Date.now().toString(36)}-none`;
    const peerOp = persist(mkOp(newOpId("op_freeform"), "freeform"));
    trackOpForSession(peerOp.id, sessionId, peerOp.task);

    const op = await buildOpFromArgs({
      task: "some distinct downstream task",
      lane: "interactive",
      _sessionId: sessionId,
    });

    expect(op.parentOpId).toBeUndefined();
  });

  it("leaves parentOpId undefined when there is no session at all", async () => {
    const op = await buildOpFromArgs({ task: "unattended task", lane: "interactive" });
    expect(op.parentOpId).toBeUndefined();
  });
});

describe("session-bridge-observer — parentOpId flows onto bg_op events", () => {
  const events: ServerEvent[] = [];

  beforeEach(() => {
    events.length = 0;
    setSessionBroadcaster((_sessionId, event) => { events.push(event); });
  });

  const stateChanged = (opId: string, from: string | null, to: string): CanonicalEvent =>
    ({ type: "state_changed", opId, body: { from, to } } as unknown as CanonicalEvent);

  it("carries parentOpId onto bg_op_queued and bg_op_started", () => {
    const sessionId = `chat-lineage-obs-${Date.now().toString(36)}`;
    const parentId = newOpId("op_chat_turn");
    const childOp = persist(mkOp(newOpId("op_freeform"), "freeform", { parentOpId: parentId }));
    trackOpForSession(childOp.id, sessionId, childOp.task);

    recordCanonicalEvent(stateChanged(childOp.id, null, "queued"));
    recordCanonicalEvent(stateChanged(childOp.id, "queued", "running"));

    const queued = events.find(e => e.type === "bg_op_queued");
    const started = events.find(e => e.type === "bg_op_started");
    expect((queued as { parentOpId?: string } | undefined)?.parentOpId).toBe(parentId);
    expect((started as { parentOpId?: string } | undefined)?.parentOpId).toBe(parentId);
  });

  it("omits parentOpId on bg_op events for an op with no lineage", () => {
    const sessionId = `chat-lineage-obs-${Date.now().toString(36)}-bare`;
    const bareOp = persist(mkOp(newOpId("op_freeform"), "freeform"));
    trackOpForSession(bareOp.id, sessionId, bareOp.task);

    recordCanonicalEvent(stateChanged(bareOp.id, null, "queued"));

    const queued = events.find(e => e.type === "bg_op_queued");
    expect(queued).toBeDefined();
    expect((queued as { parentOpId?: string } | undefined)?.parentOpId).toBeUndefined();
  });
});
