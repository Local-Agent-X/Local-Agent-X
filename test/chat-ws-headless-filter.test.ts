/**
 * Eval sessions (/api/eval/run) run a real chat turn to observe tool routing
 * but must never reach a browser. A burst of eval calls once announced their
 * throwaway sessions over the chat WebSocket and the UI rendered the test
 * prompts into the user's open chat. broadcastActiveChats / broadcastToSession
 * filter them at the source.
 *
 * The eval id is minted by routes/chat.ts via randomId("eval"), which formats
 * `eval_<16hex>` (util/ids.ts). The filter matched `eval-` (dash) from f6e5f7b0
 * (2026-06-09) until this fix — dead the whole time, and the old fixture here
 * was typed to match the filter rather than the minter. The fixture is now
 * DERIVED from the real minter so a prefix change breaks this test instead of
 * silently re-opening the leak.
 *
 * Background jobs mint synthetic sessions too — `skill-review-`
 * (background-jobs/skill-review.ts) and `dream-` (background-jobs/dream-check.ts)
 * — filtered as a guard. Prefix matching is exact on the trailing dash:
 * `skill-reviewer` is a real session. And `ide-` sessions are live user-facing
 * chats over this socket, so the filter must NOT be widened to
 * memory/synthetic-sessions.ts's SYNTHETIC_SESSION_PREFIXES.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { randomId } from "../src/util/ids.js";
import {
  clients,
  activeChats,
  broadcastToSession,
  broadcastActiveChats,
  type ActiveChat,
} from "../src/chat-ws/state.js";

/** Exactly what /api/eval/run mints (routes/chat.ts, `randomId("eval")`). */
const EVAL_SESSION = randomId("eval");

function fakeWs(): { ws: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const ws = { readyState: 1, send: (s: string) => { sent.push(s); } } as unknown as WebSocket;
  return { ws, sent };
}

function fakeChat(sessionId: string): ActiveChat {
  return { sessionId, events: [], abortController: new AbortController(), startedAt: 1, done: false };
}

afterEach(() => { clients.clear(); activeChats.clear(); });

describe("chat-ws headless (eval_) session filtering", () => {
  it("the minted eval id carries the underscore prefix the filter must match", () => {
    // Only the prefix is this test's invariant; the body format is pinned in
    // src/util/ids.test.ts where it belongs.
    expect(EVAL_SESSION.startsWith("eval_")).toBe(true);
  });

  it("broadcastActiveChats omits the eval session, keeps real ones", () => {
    activeChats.set("chat-real", fakeChat("chat-real"));
    activeChats.set(EVAL_SESSION, fakeChat(EVAL_SESSION));
    const { ws, sent } = fakeWs();
    clients.set(ws, new Set());

    broadcastActiveChats();

    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]) as { type: string; sessionIds: string[] };
    expect(msg.type).toBe("active_chats");
    expect(msg.sessionIds).toEqual(["chat-real"]);
  });

  it("broadcastToSession never sends for the eval session, even to a subscriber", () => {
    const { ws, sent } = fakeWs();
    clients.set(ws, new Set([EVAL_SESSION, "chat-real"]));

    broadcastToSession(EVAL_SESSION, { type: "stream", delta: "secret test prompt" } as never);
    expect(sent).toHaveLength(0);

    broadcastToSession("chat-real", { type: "stream", delta: "real" } as never);
    expect(sent).toHaveLength(1);
  });
});

describe("chat-ws headless filtering of background-job sessions (skill-review-, dream-)", () => {
  const HEADLESS = ["skill-review-123", "dream-456", "dream-456-b0", EVAL_SESSION];
  const DELIVERABLE = ["chat-abc", "skill-reviewer", "dreamer", "ide-todo-app"];

  it("broadcastActiveChats omits every headless prefix and keeps every real session", () => {
    for (const id of [...HEADLESS, ...DELIVERABLE]) activeChats.set(id, fakeChat(id));
    const { ws, sent } = fakeWs();
    clients.set(ws, new Set());

    broadcastActiveChats();

    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]) as { type: string; sessionIds: string[] };
    expect(msg.type).toBe("active_chats");
    expect(msg.sessionIds).toEqual(DELIVERABLE);
  });

  it("broadcastToSession never sends for a headless session, even to a subscriber", () => {
    const { ws, sent } = fakeWs();
    clients.set(ws, new Set([...HEADLESS, ...DELIVERABLE]));

    for (const id of HEADLESS) {
      broadcastToSession(id, { type: "stream", delta: `leak from ${id}` } as never);
    }
    expect(sent).toHaveLength(0);
  });

  it("broadcastToSession still delivers for near-miss ids (no trailing-dash match) and ide- chats", () => {
    const { ws, sent } = fakeWs();
    clients.set(ws, new Set(DELIVERABLE));

    for (const id of DELIVERABLE) {
      broadcastToSession(id, { type: "stream", delta: id } as never);
    }
    expect(sent).toHaveLength(DELIVERABLE.length);
    const delivered = sent.map(s => (JSON.parse(s) as { sessionId: string }).sessionId);
    expect(delivered).toEqual(DELIVERABLE);
  });
});
