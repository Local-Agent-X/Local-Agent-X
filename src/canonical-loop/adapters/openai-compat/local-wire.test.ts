// The local wire is a strict extension of the last round: what qwen3.6, a
// hybrid model, needs to reuse its cache at all (see local-wire.ts).
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { extendLocalWire, LOCAL_TAIL_EVERY, thinkLevelInPrompt, type LocalWireState } from "./local-wire.js";

const user = (content: string): ChatCompletionMessageParam => ({ role: "user", content });
const tool = (content: string): ChatCompletionMessageParam => ({ role: "tool", tool_call_id: "c", content });
const tail = (turn: number) => [user(`[SITUATIONAL CONTEXT] turn ${turn}`)];

function round(turnIdx: number, durable: ChatCompletionMessageParam[], redirect = false) {
  return { turnIdx, durable, tail: tail(turnIdx), redirect };
}

const startsWith = (a: ChatCompletionMessageParam[], prefix: ChatCompletionMessageParam[]) =>
  prefix.every((row, i) => JSON.stringify(row) === JSON.stringify(a[i]));

describe("extendLocalWire", () => {
  it("sends the first round as built", () => {
    const { messages } = extendLocalWire(null, round(0, [user("build it")]));
    expect(messages).toEqual([user("build it"), ...tail(0)]);
  });

  it("makes every later round a strict extension of the one before, the old tails kept where they were", () => {
    let state: LocalWireState | null = null;
    let durable: ChatCompletionMessageParam[] = [user("build it")];
    let last: ChatCompletionMessageParam[] = [];
    for (let turn = 0; turn < 3 * LOCAL_TAIL_EVERY; turn++) {
      const out = extendLocalWire(state, round(turn, durable));
      expect(startsWith(out.messages, last), `turn ${turn}`).toBe(true);
      last = out.messages;
      state = out.state;
      durable = [...durable, { role: "assistant", content: `step ${turn}` }, tool(`result ${turn}`)];
    }
    const tails = last.filter((m) => String(m.content).startsWith("[SITUATIONAL"));
    expect(tails.map((m) => m.content)).toEqual([
      "[SITUATIONAL CONTEXT] turn 0",
      `[SITUATIONAL CONTEXT] turn ${LOCAL_TAIL_EVERY}`,
      `[SITUATIONAL CONTEXT] turn ${2 * LOCAL_TAIL_EVERY}`,
    ]);
  });

  it("starts over when compaction rewrote the history", () => {
    const first = extendLocalWire(null, round(0, [user("a"), tool("b")]));
    const out = extendLocalWire(first.state, round(1, [user("summary of a and b"), tool("c")]));
    expect(out.messages).toEqual([user("summary of a and b"), tool("c"), ...tail(1)]);
  });

  it("sends a redirect fresh and keeps no state, so the loop's own row for it cannot be doubled", () => {
    const first = extendLocalWire(null, round(0, [user("a")]));
    const redirected = extendLocalWire(first.state, round(1, [user("a"), tool("b")], true));
    expect(redirected.state).toBeNull();
    expect(redirected.messages).toEqual([user("a"), tool("b"), ...tail(1)]);
  });

  it("sends a fresh tail when the round count goes back (a new op on a reused adapter)", () => {
    const first = extendLocalWire(null, round(5, [user("a")]));
    const out = extendLocalWire(first.state, round(0, [user("a"), tool("b")]));
    expect(out.messages.at(-1)).toEqual(tail(0)[0]);
  });
});

describe("thinkLevelInPrompt", () => {
  it("holds for a model that lists think levels: Ollama renders the level into the system turn", () => {
    expect(thinkLevelInPrompt({ values: [false, "low", "medium", "xhigh"], default: "medium" })).toBe(true);
    expect(thinkLevelInPrompt({ values: ["low", "medium", "high"], default: "medium" })).toBe(true);
  });

  it("does not for a boolean think model, an off-only one, or one discovery has not described", () => {
    expect(thinkLevelInPrompt({ values: [false, true], default: true })).toBe(false);
    expect(thinkLevelInPrompt({ values: [false], default: false })).toBe(false);
    expect(thinkLevelInPrompt(null)).toBe(false);
    expect(thinkLevelInPrompt(undefined)).toBe(false);
  });
});
