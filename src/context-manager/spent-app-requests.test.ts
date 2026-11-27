// A build's lead re-read every finished decision in full on every later one: 36
// packets, 64% of each ~230K-token call; half answered, half never answered and
// decided by the engine's own rules (label-check-grok, 2026-11-27). Once a
// decision's turn is over, the lead's view keeps its headline and how it was
// answered, not the evidence. Built from the real packet the engine sends
// (leadPacket), so a change to its wording that breaks this shows here.
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { shortenSpentAppRequests } from "./spent-app-requests.js";
import { applyCheckpoint } from "./checkpoint-history.js";
import { markHarnessRow } from "../harness-rows.js";
import { leadPacket, type LeadSituation } from "../auto-build/advisor/lead-decisions.js";
import { LEAD_ROLE } from "../auto-build/advisor/lead-role.js";

const situation: LeadSituation = {
  chunk: { number: 3, title: "Label scanner", slice: "scan a label", doneWhen: "the scan fixtures pass", scenarios: "S4" },
  totalChunks: 8, round: 2, finding: "FINDING-TEXT: the parser drops U+2028 lines.", workerReport: "STATUS: done — WORKER-REPORT",
  earlier: ["blank glyphs were kept"], repeated: false, maxRounds: 4,
};

const packet = (id: string, first = false): ChatCompletionMessageParam => ({ role: "user", content: leadPacket(id, situation, first) });
const decide = (id: string, args: Record<string, unknown>): ChatCompletionMessageParam => ({
  role: "assistant", content: "",
  tool_calls: [{ id: `call-${id}`, type: "function", function: { name: "build_decide", arguments: JSON.stringify({ decision_id: id, ...args }) } }],
} as ChatCompletionMessageParam);
const result = (id: string): ChatCompletionMessageParam => ({ role: "tool", tool_call_id: `call-${id}`, content: "[ok] decision taken" } as ChatCompletionMessageParam);
const user = (content: string): ChatCompletionMessageParam => ({ role: "user", content });
const text = (m: ChatCompletionMessageParam | undefined): string => (typeof m?.content === "string" ? m.content : "");

describe("shortenSpentAppRequests", () => {
  it("keeps an answered decision's headline, the lead role it carried and the answer, not the evidence", () => {
    const history = [packet("bd-aaaa1111", true), decide("bd-aaaa1111", { action: "accept", reasoning: "Rounds are spent; the rest is out of scope." }), result("bd-aaaa1111"), user("next")];
    const [shortened] = shortenSpentAppRequests(history);
    expect(text(shortened)).toContain("a build decision is waiting");
    expect(text(shortened)).toContain(LEAD_ROLE);
    expect(text(shortened)).toContain('Decision bd-aaaa1111: chunk 3/8, "Label scanner", after fix round 2 of at most 4.');
    expect(text(shortened)).toContain('[Answered with build_decide: action="accept", reasoning="Rounds are spent; the rest is out of scope."');
    expect(text(shortened)).not.toContain("FINDING-TEXT");
    expect(text(shortened)).not.toContain("WORKER-REPORT");
  });

  // The engine waits only for the turn a decision lands in; a turn that ends
  // without build_decide is no answer, and the engine decides by its own rules.
  it("shortens a decision whose turn ended unanswered, and says so", () => {
    const history = [packet("bd-aaaa1111"), { role: "assistant", content: "Looking into it." } as ChatCompletionMessageParam, packet("bd-bbbb2222")];
    const [shortened] = shortenSpentAppRequests(history);
    expect(text(shortened)).toContain("Not answered with build_decide in its turn; the app went on by its own rules");
    expect(text(shortened)).not.toContain("FINDING-TEXT");
    expect(text(shortenSpentAppRequests(history)[2])).toBe(text(history[2]));
  });

  it("leaves the decision still in its turn whole, answered yet or not", () => {
    const waiting = [user("earlier"), packet("bd-aaaa1111")];
    expect(shortenSpentAppRequests(waiting)).toBe(waiting);
    const answering = [packet("bd-aaaa1111"), decide("bd-aaaa1111", { action: "accept", reasoning: "r" }), result("bd-aaaa1111")];
    expect(shortenSpentAppRequests(answering)).toBe(answering);
  });

  it("does not take a nudge inside the turn for the next turn", () => {
    const nudge = markHarnessRow({ role: "user", content: "[automatic check] steps are still open" }, "nudge");
    const history = [packet("bd-aaaa1111"), nudge];
    expect(shortenSpentAppRequests(history)).toBe(history);
  });

  it("does not count a call made in another turn, before or after", () => {
    const before = [decide("bd-aaaa1111", { action: "accept", reasoning: "r" }), packet("bd-aaaa1111"), user("next")];
    expect(text(shortenSpentAppRequests(before)[1])).toContain("Not answered");
    const after = [packet("bd-aaaa1111"), user("next"), decide("bd-aaaa1111", { action: "accept", reasoning: "r" })];
    expect(text(shortenSpentAppRequests(after)[0])).toContain("Not answered");
  });

  it("keeps the row count and gives the same view every time, so the prompt cache holds", () => {
    const history = [packet("bd-aaaa1111"), decide("bd-aaaa1111", { action: "continue", reasoning: "a real gap", instruction: "check root build/" }), result("bd-aaaa1111"), packet("bd-dddd4444")];
    const once = shortenSpentAppRequests(history);
    expect(once).toHaveLength(history.length);
    expect(shortenSpentAppRequests(history)).toEqual(once);
    expect(text(once[3])).toBe(text(history[3]));
  });

  it("shortens a long answer, and a call whose arguments do not parse is no answer", () => {
    const long = { action: "narrow", reasoning: "x".repeat(2000) };
    expect(text(shortenSpentAppRequests([packet("bd-aaaa1111"), decide("bd-aaaa1111", long), user("next")])[0]).length).toBeLessThan(1000);
    const broken = { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "build_decide", arguments: "{not json" } }] } as ChatCompletionMessageParam;
    expect(text(shortenSpentAppRequests([packet("bd-aaaa1111"), broken, user("next")])[0])).toContain("Not answered");
  });

  it("leaves a user's own message alone even when it quotes an answer line", () => {
    const history: ChatCompletionMessageParam[] = [user('Answer with build_decide(decision_id="bd-aaaa1111", ...): why does it say that?'), user("next")];
    expect(shortenSpentAppRequests(history)).toBe(history);
  });

  it("is part of the view every chat request is sent", () => {
    const history = [packet("bd-aaaa1111"), decide("bd-aaaa1111", { action: "accept", reasoning: "r" }), result("bd-aaaa1111"), user("next")];
    expect(text(applyCheckpoint(history, undefined)[0])).not.toContain("FINDING-TEXT");
  });
});

// The lead eval (eval/build-lead) judges the lead on the packet as sent: the
// answer line reads exactly as it did before it was written through harness-text.
describe("the decision packet's answer line", () => {
  it("is unchanged", () => {
    expect(text(packet("bd-aaaa1111"))).toContain('Answer with build_decide(decision_id="bd-aaaa1111", ...): one call. Then, only if it changes something the owner would want to know, a line for them; then end your turn.');
  });
});
