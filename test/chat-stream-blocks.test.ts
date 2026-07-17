// @vitest-environment happy-dom
//
// Block-timeline contract for the chat stream store (2026-07-16). The old
// render shape kept ONE flat reasoning string that always painted at the top
// of the bubble, so a multi-phase turn (think → answer → tool → think →
// answer) showed a growing "wall of thinking" pinned above text streamed
// after it — and mid-turn user injects spliced ABOVE the whole live row.
// These tests pin the ordered blocks[] timeline that fixes both, including
// the replay path (per-lane wipe + boundary-stamped run deltas from
// replay.ts) that must reconstruct the same timeline after a reconnect.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface Block {
  id: string;
  type: "text" | "reasoning" | "inject";
  text: string;
  injectId?: string;
  queueState?: "queued" | "consumed";
}
interface Entry { content: string; reasoning: string; blocks: Block[] }
interface ChatMessage {
  role: string; content: string;
  _blocks?: Block[]; _injectId?: string; _queueState?: string; _reasoning?: string;
}
interface FakeChat { messages: ChatMessage[] }
interface Store {
  get(sessionId: string): Entry | null;
  startTurn(sessionId: string, anchorIdx?: number): unknown;
  applyEvent(sessionId: string, event: Record<string, unknown>): void;
  addInject(sessionId: string, injectId: string, text: string): boolean;
  consumeInject(sessionId: string, injectId: string, text?: string): boolean;
  promoteLiveToMessages(sessionId: string, chat: FakeChat): ChatMessage | null;
}

let ChatStreamStore: Store;

beforeEach(() => {
  for (const f of ["chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
    const src = readFileSync(join(here, "../public/js/" + f), "utf8");
    // eslint-disable-next-line no-new-func
    new Function(src)();
  }
  ChatStreamStore = (globalThis as unknown as { window: { ChatStreamStore: Store } }).window.ChatStreamStore;
});

const shape = (blocks: Block[]) => blocks.map(b => [b.type, b.text] as const);

describe("blocks[] — arrival-order timeline", () => {
  const sid = "s-blocks";

  it("interleaves reasoning and text in the order they streamed (no thinking-first retcon)", () => {
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "reasoning", delta: "plan it " });
    ChatStreamStore.applyEvent(sid, { type: "reasoning", delta: "carefully" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Step one. " });
    ChatStreamStore.applyEvent(sid, { type: "reasoning", delta: "now step two" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Step two." });

    const e = ChatStreamStore.get(sid)!;
    expect(shape(e.blocks)).toEqual([
      ["reasoning", "plan it carefully"],
      ["text", "Step one. "],
      ["reasoning", "now step two"],
      ["text", "Step two."],
    ]);
    // Flat lanes stay intact for persistence/TTS — built from the same events.
    expect(e.content).toBe("Step one. Step two.");
    expect(e.reasoning).toBe("plan it carefullynow step two");
  });

  it("a tool call splits same-lane text into separate blocks (and the lane keeps its \\n\\n break)", () => {
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Checking." });
    ChatStreamStore.applyEvent(sid, { type: "tool_start", toolName: "bash", toolCallId: "c1" });
    ChatStreamStore.applyEvent(sid, { type: "tool_end", toolName: "bash", toolCallId: "c1" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Done." });

    const e = ChatStreamStore.get(sid)!;
    expect(shape(e.blocks)).toEqual([
      ["text", "Checking."],
      ["text", "\n\nDone."],
    ]);
    expect(e.content).toBe("Checking.\n\nDone.");
  });

  it("stream replace drops only the text blocks and reseeds the lane at the tail", () => {
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "reasoning", delta: "hmm" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: '{"tool":"x"}' });
    ChatStreamStore.applyEvent(sid, { type: "stream", replace: true, text: "clean answer" });

    const e = ChatStreamStore.get(sid)!;
    expect(shape(e.blocks)).toEqual([
      ["reasoning", "hmm"],
      ["text", "clean answer"],
    ]);
    expect(e.content).toBe("clean answer");
  });
});

describe("blocks[] — replay reconstruction (wipe + boundary-stamped run deltas)", () => {
  const sid = "s-replay";

  it("rebuilds the interleaved timeline a fresh client never saw live", () => {
    // Mirror replay.ts frame order for a think→text→tool→text turn:
    // wipes first, then runs in arrival order, then the buffered tool events.
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "stream", replace: true, text: "" });
    ChatStreamStore.applyEvent(sid, { type: "reasoning", replace: true, text: "" });
    ChatStreamStore.applyEvent(sid, { type: "reasoning", delta: "let me look" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "partial " });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "\n\nanswer", boundary: true });
    ChatStreamStore.applyEvent(sid, { type: "tool_start", toolName: "bash", toolCallId: "c1" });
    ChatStreamStore.applyEvent(sid, { type: "tool_end", toolName: "bash", toolCallId: "c1" });

    const e = ChatStreamStore.get(sid)!;
    expect(shape(e.blocks)).toEqual([
      ["reasoning", "let me look"],
      ["text", "partial "],
      ["text", "\n\nanswer"],
    ]);
    // Byte-identical lane text — run texts are exact accumulator slices, so
    // the replayed deltas append plainly (post-wipe toolsSinceText is false;
    // no double paragraph break).
    expect(e.content).toBe("partial \n\nanswer");
  });

  it("wipe-then-deltas onto a client that already holds the partial does not double-count", () => {
    ChatStreamStore.startTurn(sid, 0);
    // Live partial before the WS blip.
    ChatStreamStore.applyEvent(sid, { type: "reasoning", delta: "thinking" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "partial" });
    // Reconnect replay.
    ChatStreamStore.applyEvent(sid, { type: "stream", replace: true, text: "" });
    ChatStreamStore.applyEvent(sid, { type: "reasoning", replace: true, text: "" });
    ChatStreamStore.applyEvent(sid, { type: "reasoning", delta: "thinking" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "partial" });

    const e = ChatStreamStore.get(sid)!;
    expect(e.content).toBe("partial");
    expect(e.reasoning).toBe("thinking");
    expect(shape(e.blocks)).toEqual([
      ["reasoning", "thinking"],
      ["text", "partial"],
    ]);
  });
});

describe("blocks[] — mid-turn injects live INSIDE the turn", () => {
  const sid = "s-inject";

  it("an inject lands at the tail of the timeline and the agent continues beneath it", () => {
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "working on red " });
    expect(ChatStreamStore.addInject(sid, "inj-1", "make it blue")).toBe(true);
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "switching to blue" });

    const e = ChatStreamStore.get(sid)!;
    expect(e.blocks.map(b => b.type)).toEqual(["text", "inject", "text"]);
    expect(e.blocks[1]).toMatchObject({ injectId: "inj-1", text: "make it blue", queueState: "queued" });
    // Post-inject text is a NEW block — the inject visually splits the answer.
    expect(e.blocks[2].text).toBe("switching to blue");
    // Inject text never leaks into the persisted content lane.
    expect(e.content).toBe("working on red switching to blue");
  });

  it("consumeInject flips queued → consumed; materializes from the replayed message when the echo died", () => {
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.addInject(sid, "inj-1", "make it blue");
    expect(ChatStreamStore.consumeInject(sid, "inj-1")).toBe(true);
    expect(ChatStreamStore.get(sid)!.blocks[0].queueState).toBe("consumed");
    // Idempotent.
    expect(ChatStreamStore.consumeInject(sid, "inj-1")).toBe(false);

    // Echo-died path: no local block, but the replay frame carries `message`.
    expect(ChatStreamStore.consumeInject(sid, "inj-2", "and add a border")).toBe(true);
    const b = ChatStreamStore.get(sid)!.blocks[1];
    expect(b).toMatchObject({ type: "inject", injectId: "inj-2", text: "and add a border", queueState: "consumed" });
  });

  it("promote keeps consumed injects inline in _blocks and re-emits queued ones as user rows AFTER the reply", () => {
    const chat: FakeChat = { messages: [{ role: "user", content: "make a page" }] };
    ChatStreamStore.startTurn(sid, 1);
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "building it " });
    ChatStreamStore.addInject(sid, "inj-a", "use blue");
    ChatStreamStore.consumeInject(sid, "inj-a");
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "blue it is" });
    // Sent seconds before `done` — never drained into THIS turn.
    ChatStreamStore.addInject(sid, "inj-b", "also add a footer");
    ChatStreamStore.applyEvent(sid, { type: "done" });

    const msg = ChatStreamStore.promoteLiveToMessages(sid, chat)!;
    expect(msg).not.toBeNull();
    // Consumed inject rides inline; queued one is NOT baked into the row.
    expect(msg._blocks!.map(b => b.type)).toEqual(["text", "inject", "text"]);
    expect(msg._blocks![1]).toMatchObject({ injectId: "inj-a", queueState: "consumed" });
    // messages: user prompt, assistant reply, then the pending inject row.
    expect(chat.messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(chat.messages[2]).toMatchObject({
      content: "also add a footer", _injectId: "inj-b", _queueState: "queued",
    });

    // Redundant second done (watchdog replay) must not re-splice anything.
    ChatStreamStore.applyEvent(sid, { type: "done" });
    expect(ChatStreamStore.promoteLiveToMessages(sid, chat)).toBeNull();
    expect(chat.messages).toHaveLength(3);
  });
});
