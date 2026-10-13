// What recall surfaced for a turn stays in the conversation (recall-carry.ts).
// The flip-flop it closes, measured on qwen3.6:27b 2026-10-08/09: the question
// turn recalled the user's own message and answered right; the pushback turn
// ("you made that up") has no topic words, recalled nothing, and the model —
// its evidence gone — retracted a true fact in every run. The replay through
// the op store and both wires is in canonical-loop/chat-runner/seed-messages.test.ts.
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { RecalledMemory } from "../memory/auto-search-context.js";
import { carriedRecallRefs, recallRow, uncarriedRecall, withRecallCarried } from "./recall-carry.js";
import { harnessRowKind, markHarnessRow } from "../harness-rows.js";
import { retractLastTurn } from "../memory/retract-last-turn.js";

const SOURCE = '[PAST SESSION — session, ref: m28, session: chat-0, date: 2026-10-08 21:10 local]\n[user] Remember this for later: in 2014 my cousin Odalys texted my brother "did you sell Merriweather yet".';
const recalled = (...entries: Array<[string, string]>): RecalledMemory =>
  ({ entries: entries.map(([ref, text]) => ({ ref, text })), pastSessions: true });

const question: ChatCompletionMessageParam = { role: "user", content: "What did my cousin text my brother back in 2014?" };
const answer: ChatCompletionMessageParam = { role: "assistant", content: 'She texted "did you sell Merriweather yet".' };

describe("recall is kept after the user's message it answered", () => {
  it("places one tagged row right after the user's message, inside the turn", () => {
    const rows = withRecallCarried([question, answer], recalled(["m28", SOURCE]));
    expect(rows.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(harnessRowKind(rows[1])).toBe("recall");
    expect(rows[1].content).toContain("did you sell Merriweather yet");
    expect(rows[1].content).toContain("not written by the user");
  });

  it("adds nothing when the turn recalled nothing", () => {
    expect(withRecallCarried([question, answer], null)).toEqual([question, answer]);
    expect(recallRow({ entries: [], pastSessions: false })).toBeNull();
  });

  it("anchors on the user's own row, not a harness row that wears role user", () => {
    const nudge = markHarnessRow({ role: "user", content: "verify first" } as ChatCompletionMessageParam, "nudge");
    const rows = withRecallCarried([question, answer, nudge], recalled(["m28", SOURCE]));
    expect(rows.indexOf(question)).toBe(0);
    expect(harnessRowKind(rows[1])).toBe("recall");
  });

  it("is retracted with its turn", () => {
    const earlier: ChatCompletionMessageParam[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }];
    const session = [...earlier, ...withRecallCarried([question, answer], recalled(["m28", SOURCE]))];
    expect(retractLastTurn(session, { includeUser: true }).messages).toEqual(earlier);
  });
});

describe("a chat does not re-show what it already carries", () => {
  const history = withRecallCarried([question, answer], recalled(["m28", SOURCE]));

  it("reads carried refs only from recall rows", () => {
    const typed: ChatCompletionMessageParam = { role: "user", content: "the doc says ref: m99" };
    expect([...carriedRecallRefs([...history, typed])]).toEqual(["m28"]);
  });

  it("drops carried entries and keeps new ones; nothing new is null", () => {
    expect(uncarriedRecall(recalled(["m28", SOURCE], ["m40", "[x, ref: m40]\nnew"]), history)?.entries.map((e) => e.ref)).toEqual(["m40"]);
    expect(uncarriedRecall(recalled(["m28", SOURCE]), history)).toBeNull();
    expect(uncarriedRecall(null, history)).toBeNull();
  });
});
