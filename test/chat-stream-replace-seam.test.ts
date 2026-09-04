// @vitest-environment happy-dom
//
// Cross-seam contract for the lane `replace` rule (2026-09-03).
//
// The rule is implemented twice by necessity — once in browser JS for the
// live client's block timeline (public/js/chat-stream-blocks.js
// replaceBlockLane) and once in TS for the server's replay runs
// (src/chat-ws/state.ts replaceRunLane). A live client applies the replace to
// its blocks; a client that reconnects a moment later rebuilds the same turn
// from the runs. If the two rules drift, the same turn renders differently
// depending on whether the socket happened to blip — the exact class of
// silent seam regression that let the "wall of thinking" bug (every Thinking
// chip stacked at the top of the bubble, one slab of answer underneath) exist
// on the replace path while the delta path was correct.
//
// This test drives one scripted turn through BOTH implementations and asserts
// the resulting timelines are identical.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendRun, replaceRunLane, type ActiveChat, type TurnRun } from "../src/chat-ws/state.js";

const here = dirname(fileURLToPath(import.meta.url));

type Step =
  | { op: "delta"; lane: "stream" | "reasoning"; text: string }
  | { op: "replace"; lane: "stream" | "reasoning"; text: string };

interface Block { type: "text" | "reasoning" | "inject"; text: string }
interface Entry { blocks: Block[] }
interface Store {
  get(sessionId: string): Entry | null;
  startTurn(sessionId: string, anchorIdx?: number): unknown;
  applyEvent(sessionId: string, event: Record<string, unknown>): void;
}

let ChatStreamStore: Store;

beforeEach(() => {
  for (const f of ["chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(join(here, "../public/js/" + f), "utf8"))();
  }
  ChatStreamStore = (globalThis as unknown as { window: { ChatStreamStore: Store } }).window.ChatStreamStore;
});

/** Server side: fold the script into the ordered run list the way
 *  manager.onEvent does, then report the (lane, text) timeline. */
function serverTimeline(script: Step[]): Array<[string, string]> {
  const chat = { runs: [] as TurnRun[], runBoundary: false } as unknown as ActiveChat;
  for (const s of script) {
    if (s.op === "delta") appendRun(chat, s.lane, s.text);
    else replaceRunLane(chat, s.lane, s.text);
  }
  return chat.runs.map(r => [r.lane, r.text] as [string, string]);
}

/** Client side: same script as WS events, reported in the same vocabulary
 *  (the block timeline calls the answer lane "text", the wire calls it
 *  "stream"). */
function clientTimeline(sid: string, script: Step[]): Array<[string, string]> {
  ChatStreamStore.startTurn(sid, 0);
  for (const s of script) {
    ChatStreamStore.applyEvent(sid, s.op === "delta"
      ? { type: s.lane, delta: s.text }
      : { type: s.lane, replace: true, text: s.text });
  }
  return ChatStreamStore.get(sid)!.blocks.map(b => [b.type === "text" ? "stream" : b.type, b.text] as [string, string]);
}

const CASES: Array<{ name: string; script: Step[]; expected: Array<[string, string]> }> = [
  {
    // The reported bug: three think/answer phases, then a sanitize repair that
    // only touched the tail. Nothing may be reordered.
    name: "late-diverging repair over a multi-phase turn",
    script: [
      { op: "delta", lane: "reasoning", text: "one" },
      { op: "delta", lane: "stream", text: "First. " },
      { op: "delta", lane: "reasoning", text: "two" },
      { op: "delta", lane: "stream", text: "Second. " },
      { op: "delta", lane: "reasoning", text: "three" },
      { op: "delta", lane: "stream", text: "Third.<|end|>" },
      { op: "replace", lane: "stream", text: "First. Second. Third." },
    ],
    expected: [
      ["reasoning", "one"], ["stream", "First. "],
      ["reasoning", "two"], ["stream", "Second. "],
      ["reasoning", "three"], ["stream", "Third."],
    ],
  },
  {
    name: "identical replace changes nothing",
    script: [
      { op: "delta", lane: "stream", text: "A" },
      { op: "delta", lane: "reasoning", text: "r" },
      { op: "delta", lane: "stream", text: "B" },
      { op: "replace", lane: "stream", text: "AB" },
    ],
    expected: [["stream", "A"], ["reasoning", "r"], ["stream", "B"]],
  },
  {
    name: "mid-timeline divergence collapses only the tail of the lane",
    script: [
      { op: "delta", lane: "stream", text: "keep " },
      { op: "delta", lane: "reasoning", text: "think" },
      { op: "delta", lane: "stream", text: "WRONG" },
      { op: "delta", lane: "reasoning", text: "more" },
      { op: "delta", lane: "stream", text: "ALSO WRONG" },
      { op: "replace", lane: "stream", text: "keep right" },
    ],
    expected: [
      ["stream", "keep "], ["reasoning", "think"],
      ["stream", "right"], ["reasoning", "more"],
    ],
  },
  {
    name: "replace longer than what streamed appends at the tail",
    script: [
      { op: "delta", lane: "stream", text: "A" },
      { op: "delta", lane: "reasoning", text: "t" },
      { op: "replace", lane: "stream", text: "A plus more" },
    ],
    expected: [["stream", "A"], ["reasoning", "t"], ["stream", " plus more"]],
  },
  {
    name: "empty replace wipes the lane whole",
    script: [
      { op: "delta", lane: "reasoning", text: "thought" },
      { op: "delta", lane: "stream", text: "a lie" },
      { op: "replace", lane: "stream", text: "" },
    ],
    expected: [["reasoning", "thought"]],
  },
  {
    // The reconnect shape from replay.ts: both lanes wiped, then the ordered
    // runs replayed as deltas.
    name: "replay wipe of both lanes empties the timeline",
    script: [
      { op: "delta", lane: "reasoning", text: "r" },
      { op: "delta", lane: "stream", text: "t" },
      { op: "replace", lane: "stream", text: "" },
      { op: "replace", lane: "reasoning", text: "" },
    ],
    expected: [],
  },
  {
    name: "reasoning lane replace is governed by the same rule",
    script: [
      { op: "delta", lane: "reasoning", text: "keep " },
      { op: "delta", lane: "stream", text: "answer" },
      { op: "delta", lane: "reasoning", text: "junk" },
      { op: "replace", lane: "reasoning", text: "keep clean" },
    ],
    expected: [["reasoning", "keep "], ["stream", "answer"], ["reasoning", "clean"]],
  },
];

describe("lane replace — client blocks and server runs agree", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const server = serverTimeline(c.script);
      const client = clientTimeline("seam-" + c.name, c.script);
      expect(server).toEqual(c.expected);
      expect(client).toEqual(c.expected);
    });
  }

  it("both sides preserve the concatenation invariant for the replaced lane", () => {
    for (const c of CASES) {
      const last = [...c.script].reverse().find(s => s.op === "replace")!;
      const join = (t: Array<[string, string]>) =>
        t.filter(([lane]) => lane === last.lane).map(([, text]) => text).join("");
      // Only meaningful for the LAST replace's lane — an earlier replace on
      // the other lane may be followed by more deltas.
      expect(join(serverTimeline(c.script))).toBe(last.text);
      expect(join(clientTimeline("inv-" + c.name, c.script))).toBe(last.text);
    }
  });
});
