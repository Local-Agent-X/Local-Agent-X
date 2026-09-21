// @vitest-environment happy-dom
//
// The reply that rendered twice, interleaved with itself.
//
// 2026-09-21: the server's event loop blocked for 218s. The browser's
// heartbeat gave up and called close() — but a close handshake needs the peer,
// and the peer was blocked, so that socket sat in CLOSING and went on firing
// onmessage while its replacement subscribed and replayed. Both fed the same
// store. Text is the one lane where that is destructive: every other frame
// class is idempotent by identity (tool_* by toolCallId, approval_* by
// approvalId, error by its own text, done is terminal), while a `stream` delta
// does a blind `content +=`. The bubble showed the whole answer twice, the
// second copy chunked differently and interleaved with the first. The
// transcript on disk was clean — the server folds text once, at the producer;
// only the client applied it per delivery.
//
// The fix gives text frames the identity every sibling class already had: the
// server stamps each one with its position in the turn (chat-ws/manager.ts),
// the client drops anything at or below the mark it holds.
//
// This drives the REAL store, reducer and block timeline against frame
// sequences shaped like what manager.ts actually broadcasts, so the two halves
// of the rule cannot drift apart silently.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface Entry { content: string; reasoning: string; lastTextSeq: number; status: string }
interface Store {
  ensure(sessionId: string): Entry;
  get(sessionId: string): Entry | undefined;
  startTurn(sessionId: string, anchorIdx?: number): Entry;
  applyEvent(sessionId: string, event: Record<string, unknown>): void;
}

let ChatStreamStore: Store;

function loadClientStore(): Store {
  const read = (f: string) => readFileSync(join(here, "../public/js", f), "utf8");
  // Load order mirrors app.html: blocks and reducer both publish onto window
  // before the store core reads them.
  const src = [
    read("chat-stream-blocks.js"),
    read("chat-stream-reducer.js"),
    read("chat-stream-admit.js"),
    read("chat-stream-store.js"),
  ].join("\n;\n");
  // eslint-disable-next-line no-new-func
  new Function("window", `${src}`)(globalThis);
  return (globalThis as unknown as { ChatStreamStore: Store }).ChatStreamStore;
}

beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  ChatStreamStore = loadClientStore();
});

// A fresh session per test. Entries deliberately outlive a turn — doneOpIds
// and supersededOpIds have to keep rejecting late frames across turns — so
// sharing one id would leak a retired op into the next test.
let SESSION = "";
let nextSession = 0;

beforeEach(() => {
  SESSION = `chat-test-session-${nextSession++}`;
  ChatStreamStore.startTurn(SESSION, 0);
});

/** The frames manager.ts broadcasts for one turn: stamped, 1-based, one
 *  counter shared by both text lanes. */
function turnFrames(...parts: string[]): Record<string, unknown>[] {
  return parts.map((delta, i) => ({ type: "stream", delta, seq: i + 1, opId: "op_1" }));
}

function deliver(frames: Record<string, unknown>[]): void {
  for (const f of frames) ChatStreamStore.applyEvent(SESSION, f);
}

describe("a text frame delivered more than once", () => {
  it("lands exactly once, whatever the delivery order", () => {
    const frames = turnFrames("The right ", "interview line ", "isn't what you think.");

    deliver(frames);
    const once = ChatStreamStore.get(SESSION)!.content;
    expect(once).toBe("The right interview line isn't what you think.");

    // The orphaned socket re-delivering the same turn from the top.
    deliver(frames);
    expect(ChatStreamStore.get(SESSION)!.content).toBe(once);
  });

  it("survives the interleaving two sockets actually produce", () => {
    // Two deliveries of one turn, arriving mixed rather than one after the
    // other — the shape that made the on-screen text unreadable.
    const frames = turnFrames("because I ", "hit all ", "of them.");
    const interleaved = [
      frames[0], frames[0], frames[1], frames[0],
      frames[2], frames[1], frames[2], frames[1],
    ];
    deliver(interleaved);
    expect(ChatStreamStore.get(SESSION)!.content).toBe("because I hit all of them.");
  });

  it("keeps the block timeline in step with the flat lane", () => {
    // The renderer walks blocks, persistence reads content. A frame dropped
    // from one and not the other is the same bug wearing a different hat.
    const frames = turnFrames("one ", "two ", "three");
    deliver(frames);
    deliver(frames);
    const e = ChatStreamStore.get(SESSION)!;
    const blocks = (e as unknown as { blocks: { type: string; text: string }[] }).blocks;
    const fromBlocks = blocks.filter(b => b.type === "text").map(b => b.text).join("");
    expect(fromBlocks).toBe(e.content);
  });
});

describe("frames that must never be dropped", () => {
  it("applies an unstamped frame — replay's runs and any older server", () => {
    // replay.ts synthesizes run deltas without a seq: they follow a wipe that
    // resets the mark and are authoritative by position.
    deliver(turnFrames("stamped "));
    ChatStreamStore.applyEvent(SESSION, { type: "stream", delta: "unstamped" });
    expect(ChatStreamStore.get(SESSION)!.content).toBe("stamped unstamped");
  });

  it("applies a replace carrying the mark the client already holds", () => {
    // The replay wipe is a replace stamped with the turn's CURRENT position —
    // by definition <= the mark a caught-up client holds. Gating it on the
    // sequence would strand the stale partial it exists to clear.
    deliver(turnFrames("partial text"));
    const mark = ChatStreamStore.get(SESSION)!.lastTextSeq;
    ChatStreamStore.applyEvent(SESSION, { type: "stream", replace: true, text: "", seq: mark });
    expect(ChatStreamStore.get(SESSION)!.content).toBe("");
  });

  it("drops the orphan's in-flight copies after a replay has rebuilt the turn", () => {
    // The exact 2026-09-21 sequence: socket A has streamed part of the turn,
    // socket B joins and replays (wipe at the high-water mark, then the runs),
    // and A's copies of those same frames arrive afterwards.
    const live = turnFrames("Yes to both — ", "but be strategic ", "about what you learn.");
    deliver(live.slice(0, 2));

    const mark = 3; // server has broadcast three frames by the time B joins
    ChatStreamStore.applyEvent(SESSION, { type: "stream", replace: true, text: "", seq: mark });
    ChatStreamStore.applyEvent(SESSION, { type: "stream", delta: "Yes to both — but be strategic about what you learn." });

    deliver(live); // socket A, still closing, flushes its queue

    expect(ChatStreamStore.get(SESSION)!.content)
      .toBe("Yes to both — but be strategic about what you learn.");
  });
});

describe("the mark is per turn, not per session", () => {
  it("a new turn's opening frames are not read as already-applied", () => {
    deliver(turnFrames("first turn text", " and more", " and more still"));
    expect(ChatStreamStore.get(SESSION)!.lastTextSeq).toBe(3);

    ChatStreamStore.startTurn(SESSION, 1);
    deliver(turnFrames("second turn"));
    expect(ChatStreamStore.get(SESSION)!.content).toBe("second turn");
  });

  it("a turn taken over mid-flight resets the mark too", () => {
    // chat_op_started{supersedes} wipes the scratch without going through
    // startTurn; the mark has to go with it or the replacement turn opens
    // against the retired turn's high-water mark.
    ChatStreamStore.applyEvent(SESSION, { type: "chat_op_started", opId: "op_1" });
    deliver(turnFrames("dead turn text", " more", " more still"));
    ChatStreamStore.applyEvent(SESSION, { type: "chat_op_started", opId: "op_2", supersedes: "op_1" });
    ChatStreamStore.applyEvent(SESSION, { type: "stream", delta: "replacement", seq: 1, opId: "op_2" });
    expect(ChatStreamStore.get(SESSION)!.content).toBe("replacement");
  });
});

describe("the reasoning lane shares the turn's sequence", () => {
  it("dedupes without the two lanes shadowing each other's marks", () => {
    const frames = [
      { type: "reasoning", delta: "thinking… ", seq: 1, opId: "op_1" },
      { type: "stream", delta: "answer ", seq: 2, opId: "op_1" },
      { type: "reasoning", delta: "more thinking", seq: 3, opId: "op_1" },
      { type: "stream", delta: "text", seq: 4, opId: "op_1" },
    ];
    deliver(frames);
    deliver(frames);
    const e = ChatStreamStore.get(SESSION)!;
    expect(e.content).toBe("answer text");
    expect(e.reasoning).toBe("thinking… more thinking");
  });
});
