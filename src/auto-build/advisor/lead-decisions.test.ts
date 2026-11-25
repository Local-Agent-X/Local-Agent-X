// The build lead: one chat per project build, listed under the chat that
// started it, asked what to do after each chunk the review sends back. Its
// answer comes through build_decide; no answer is the engine's own rules.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setChatHandler } from "../../chat-ws/chat-handler.js";
import { canHaveLead, leadSessionId, setLeadChatHost } from "./lead-chat.js";
import { askLead, isLeadDecisionPending, LEAD_ROLE, type LeadSituation } from "./lead-decisions.js";
import { buildDecideTool, readDecision } from "./build-decide-tool.js";

const situation: LeadSituation = {
  chunk: { number: 1, title: "Android foundation", slice: "s", doneWhen: "fixtures prove the size gate", scenarios: "—" },
  totalChunks: 5, round: 2, finding: "The skeptic broke it: the size gate skips root build/.", workerReport: "STATUS: done",
  earlier: ["nested dist/ was skipped"], repeated: false,
};
const ref = { projectDir: "C:/ws/apps/label-check-sol", originSessionId: "chat-origin" };

let created: Array<{ sessionId: string; originId: string; title: string }>;
let messages: Array<{ sessionId: string; message: string }>;
beforeEach(() => {
  created = []; messages = [];
  setLeadChatHost({ create: async (req) => { created.push(req); }, exists: (id) => created.some((c) => c.sessionId === id) });
});
afterEach(() => { setLeadChatHost(null); });

/** A lead that answers each message by calling build_decide with `args`. */
function leadAnswers(args: Record<string, unknown> | null): void {
  setChatHandler(async (sessionId, message) => {
    messages.push({ sessionId, message });
    const id = message.match(/build_decide\(decision_id="([^"]+)"/)?.[1];
    if (args && id) await buildDecideTool.execute({ decision_id: id, ...args }, undefined as never);
  });
}

describe("the build lead", () => {
  it("has a chat of its own, started from the build's chat, the same one for every decision of the project", async () => {
    leadAnswers({ action: "continue", reasoning: "a real gap", instruction: "check root build/ too" });
    const first = await askLead(ref, situation, { answerMs: 5_000 });
    expect(first).toEqual({ action: "continue", reasoning: "a real gap", instruction: "check root build/ too" });
    await askLead(ref, situation, { answerMs: 5_000 });
    expect(created).toEqual([{ sessionId: leadSessionId(ref.projectDir), originId: "chat-origin", title: "Build lead: label-check-sol" }]);
    expect(new Set(messages.map((m) => m.sessionId))).toEqual(new Set([leadSessionId(ref.projectDir)]));
    // The first message says what the lead is for; each says it is the app's, with the evidence.
    expect(messages[0].message).toContain(LEAD_ROLE.slice(0, 40));
    expect(messages[1].message).not.toContain(LEAD_ROLE.slice(0, 40));
    expect(messages[1].message).toContain("(Sent by the app, not typed by the user");
    expect(messages[1].message).toContain("the size gate skips root build/");
    expect(messages[1].message).toContain("- nested dist/ was skipped");
  });

  it("a lead that ends its turn without deciding is no answer, and nothing is left waiting", async () => {
    leadAnswers(null);
    expect(await askLead(ref, situation, { answerMs: 5_000 })).toBeNull();
    const id = messages[0].message.match(/decision_id="([^"]+)"/)![1];
    expect(isLeadDecisionPending(id)).toBe(false);
  });

  it("no lead without a way to make its chat, or for a build no chat started", async () => {
    setLeadChatHost(null);
    leadAnswers({ action: "accept", reasoning: "x" });
    expect(await askLead(ref, situation, { answerMs: 1_000 })).toBeNull();
    expect(canHaveLead("orchestrator-mabc")).toBe(false);
    expect(canHaveLead("chat-mwv6cxu8")).toBe(true);
  });
});

describe("build_decide", () => {
  it("each decision carries what it needs", () => {
    expect(readDecision({ action: "continue", reasoning: "r" })).toMatchObject({ error: expect.stringContaining("instruction") });
    expect(readDecision({ action: "narrow", reasoning: "r" })).toMatchObject({ error: expect.stringContaining("done_when") });
    expect(readDecision({ action: "park", reasoning: "r" })).toMatchObject({ error: expect.stringContaining("question") });
    expect(readDecision({ action: "ship it", reasoning: "r" })).toMatchObject({ error: expect.stringContaining("one of") });
    expect(readDecision({ action: "accept", reasoning: "beyond the chunk", follow_ups: ["root build/ ", ""] }))
      .toEqual({ action: "accept", reasoning: "beyond the chunk", followUps: ["root build/"] });
  });

  it("refuses an id nothing waits under", async () => {
    const out = await buildDecideTool.execute({ decision_id: "bd-none", action: "accept", reasoning: "x" }, undefined as never) as { isError?: boolean; content: string };
    expect(out.isError).toBe(true);
    expect(out.content).toContain('No build decision is waiting under "bd-none"');
  });
});
