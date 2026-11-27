// The build lead: the chat that started the build, asked what to do after
// each chunk the review sends back, in messages the app posts there. Its
// answer comes through build_decide; no answer is the engine's own rules.
import { describe, it, expect, beforeEach } from "vitest";
import { setChatHandler } from "../../chat-ws/chat-handler.js";
import { canHaveLead } from "./lead-chat.js";
import { askLead, askLeadBuildCall, isLeadDecisionPending, leadDecisionsWaitingOn, type LeadSituation } from "./lead-decisions.js";
import { LEAD_ROLE } from "./lead-role.js";
import { buildDecideTool, readDecision } from "./build-decide-tool.js";
import { owedToolNamesFor, requiredToolFor } from "../../agent-request/prepare-request/session-owed-tools.js";
import { FINISH_FIX_BREAK_GROUNDS, SKEPTIC_BREAK_GROUNDS } from "../chunk-review/skeptic-bar.js";

const situation: LeadSituation = {
  chunk: { number: 1, title: "Android foundation", slice: "s", doneWhen: "fixtures prove the size gate", scenarios: "—" },
  totalChunks: 5, round: 2, finding: "The skeptic broke it: the size gate skips root build/.", workerReport: "STATUS: done",
  earlier: ["nested dist/ was skipped"], repeated: false, maxRounds: 8,
};
const ref = { projectDir: "C:/ws/apps/label-check-sol", originSessionId: "chat-origin" };

let messages: Array<{ sessionId: string; message: string }>;
beforeEach(() => { messages = []; });

/** A lead that answers each message by calling build_decide with `args`. */
function leadAnswers(args: Record<string, unknown> | null): void {
  setChatHandler(async (sessionId, message) => {
    messages.push({ sessionId, message });
    const id = message.match(/build_decide\(decision_id="([^"]+)"/)?.[1];
    if (args && id) await buildDecideTool.execute({ decision_id: id, ...args }, undefined as never);
  });
}

describe("the build lead", () => {
  // For a day the lead had a chat of its own; the owner wanted one chat, with
  // the engine's posts hidden and the lead speaking in it (2026-11-25).
  it("is the chat that started the build: every decision is posted there, as the app's", async () => {
    leadAnswers({ action: "continue", reasoning: "a real gap", instruction: "check root build/ too" });
    const first = await askLead(ref, situation, { answerMs: 5_000 });
    expect(first).toEqual({ action: "continue", reasoning: "a real gap", instruction: "check root build/ too" });
    await askLead(ref, situation, { answerMs: 5_000 });
    expect(new Set(messages.map((m) => m.sessionId))).toEqual(new Set(["chat-origin"]));
    // The first message says what the lead is for; each says it is the app's, with the evidence.
    expect(messages[0].message).toContain(LEAD_ROLE.slice(0, 40));
    expect(messages[1].message).not.toContain(LEAD_ROLE.slice(0, 40));
    expect(messages[1].message).toContain("(Sent by the app, not typed by the user");
    expect(messages[1].message).toContain("the size gate skips root build/");
    expect(messages[1].message).toContain("- nested dist/ was skipped");
  });

  // label-check-grok (2026-11-26): the lead's chat was a code session whose
  // tool set did not hold build_decide after a restart, so every decision
  // timed out behind a loop of status calls. While an ask waits, the chat is
  // owed the tool; when it is settled or times out, it is not.
  it("owes its chat the decision tool for exactly as long as a decision waits", async () => {
    let duringTheTurn: string[] = [];
    setChatHandler(async (sessionId, message) => {
      duringTheTurn = owedToolNamesFor(sessionId);
      const id = message.match(/build_decide\(decision_id="([^"]+)"/)?.[1];
      if (id) await buildDecideTool.execute({ decision_id: id, action: "accept", reasoning: "holds" }, undefined as never);
    });
    await askLead(ref, situation, { answerMs: 5_000 });
    expect(duringTheTurn).toEqual(["build_decide"]);
    expect(owedToolNamesFor("chat-origin")).toEqual([]);

    // A lead that never answers: still released when the ask gives up.
    setChatHandler(async (sessionId) => { duringTheTurn = owedToolNamesFor(sessionId); });
    expect(await askLead(ref, situation, { answerMs: 5_000 })).toBeNull();
    expect(duringTheTurn).toEqual(["build_decide"]);
    expect(owedToolNamesFor("chat-origin")).toEqual([]);
  });

  // A lead that checks the build's status in the middle of a decision is told
  // there which decision waits (orchestrator/tools.ts build_plan_status).
  it("the chat a decision waits on is known, by the decision's id, until it is settled", async () => {
    let waiting: string[] = [];
    let asked = "";
    setChatHandler(async (sessionId, message) => {
      waiting = leadDecisionsWaitingOn(sessionId);
      asked = message.match(/build_decide\(decision_id="([^"]+)"/)?.[1] ?? "";
      expect(leadDecisionsWaitingOn("some-other-chat")).toEqual([]);
    });
    expect(await askLead(ref, situation, { answerMs: 5_000 })).toBeNull();
    expect(asked).toMatch(/^bd-/);
    expect(waiting).toEqual([asked]);
    expect(leadDecisionsWaitingOn("chat-origin")).toEqual([]);
  });

  // label-check-sol's chunk 3 (2026-11-25): told to keep going while rounds
  // closed what they were given, the lead sent back every fresh odd input to
  // an unmarked rule until the rounds ran out.
  it("judges by the skeptic's own bar, and knows the round budget", async () => {
    for (const ground of SKEPTIC_BREAK_GROUNDS) expect(LEAD_ROLE).toContain(ground);
    expect(LEAD_ROLE).toContain("A rule that is not marked is scoped.");
    expect(LEAD_ROLE).not.toContain("Keep going while rounds close what they were given");
    leadAnswers({ action: "accept", reasoning: "an input of a new kind" });
    await askLead(ref, situation, { answerMs: 5_000 });
    expect(messages.at(-1)!.message).toContain("after fix round 2 of at most 8.");
    expect(messages.at(-1)!.message).not.toContain("last decision for this chunk");
  });

  it("the last decision says what each answer does once the rounds are spent", async () => {
    leadAnswers({ action: "accept", reasoning: "done enough" });
    await askLead(ref, { ...situation, round: 8, final: true }, { answerMs: 5_000 });
    expect(messages.at(-1)!.message).toContain("This is the last decision for this chunk");
    expect(messages.at(-1)!.message).toContain('"continue", "fresh", "narrow" and "split" set it aside');
  });

  // label-check-sol's chunk 4 (2026-11-25): parked on a device only the owner
  // has, and chunk 5 never started.
  it("is told a check only the owner can run is owed, never a reason to park", () => {
    expect(LEAD_ROLE).toContain('"owed"');
    expect(LEAD_ROLE).toContain("Never park for that");
    expect(LEAD_ROLE).toContain('"overrule"');
  });

  // label-check-sol's finish fixes (2026-11-25): the lead answered "continue"
  // to each fresh problem the skeptic found anywhere in the app, two hours a fix.
  it("holds a finish fix to what it was given, with the skeptic's finish-fix bar", () => {
    for (const ground of FINISH_FIX_BREAK_GROUNDS) expect(LEAD_ROLE).toContain(ground);
    expect(LEAD_ROLE).toContain("already in the app before the fix");
  });

  it("a build call takes only the answers it lists; build_decide refuses the rest and the lead can answer again", async () => {
    const replies: string[] = [];
    setChatHandler(async (_sessionId, message) => {
      const id = message.match(/build_decide\(decision_id="([^"]+)"/)![1];
      for (const args of [{ action: "accept", reasoning: "fine" }, { action: "continue", reasoning: "keep building", instruction: "go on" }]) {
        const out = await buildDecideTool.execute({ decision_id: id, ...args }, undefined as never) as { content: string };
        replies.push(out.content);
      }
    });
    const decision = await askLeadBuildCall(ref, {
      kind: "set-aside-cap", title: "Three chunks are set aside", evidence: "Chunks 2, 4 and 5 were set aside.",
      answers: { continue: "keep building what does not depend on them", park: "stop the build here" }, chunkNumber: 5, totalChunks: 9,
    }, { answerMs: 5_000 });
    expect(replies[0]).toContain("takes one of: continue, park");
    expect(decision).toMatchObject({ action: "continue" });
  });

  // Four days of builds, 2026-11-24 to 27: the lead ended 21 of 28 decision
  // turns having worked its answer out in words, without the call.
  it("a lead that ends its turn without deciding is asked once more, in a turn that must open with build_decide", async () => {
    const requiredAt: Array<string | undefined> = [];
    setChatHandler(async (sessionId, message) => {
      messages.push({ sessionId, message });
      requiredAt.push(requiredToolFor(sessionId));
      const id = message.match(/build_decide\(decision_id="([^"]+)"/)?.[1];
      if (messages.length === 2 && id) await buildDecideTool.execute({ decision_id: id, action: "overrule", reasoning: "the throw is the required one", evidence: "main.tsx:12" }, undefined as never);
    });
    const decision = await askLead(ref, situation, { answerMs: 10_000 });
    expect(decision).toMatchObject({ action: "overrule" });
    expect(messages).toHaveLength(2);
    expect(messages[1].message).toContain("is still waiting: your last turn ended without the build_decide call");
    // Only the second turn is pinned to the tool; nothing stays pinned after.
    expect(requiredAt).toEqual([undefined, "build_decide"]);
    expect(requiredToolFor("chat-origin")).toBeUndefined();
    expect(owedToolNamesFor("chat-origin")).toEqual([]);
  });

  it("a lead that does not answer the second time either is no answer, and nothing is left waiting", async () => {
    leadAnswers(null);
    expect(await askLead(ref, situation, { answerMs: 10_000 })).toBeNull();
    expect(messages).toHaveLength(2);
    const id = messages[0].message.match(/decision_id="([^"]+)"/)![1];
    expect(isLeadDecisionPending(id)).toBe(false);
    expect(requiredToolFor("chat-origin")).toBeUndefined();
  });

  it("is told the owner reads the chat but not the engine's posts, and says what it decided when it matters", () => {
    expect(LEAD_ROLE).toContain("This is the owner's chat. They do not see the engine's messages to you");
  });

  it("no lead without a chat runner, or for a build no chat started", async () => {
    setChatHandler(null as never);
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
    expect(readDecision({ action: "owed", reasoning: "r" })).toMatchObject({ error: expect.stringContaining("owed_check") });
    expect(readDecision({ action: "overrule", reasoning: "r" })).toMatchObject({ error: expect.stringContaining("evidence") });
    expect(readDecision({ action: "owed", reasoning: "r", owed_check: "live scan on a Pixel 9" })).toEqual({ action: "owed", reasoning: "r", owedCheck: "live scan on a Pixel 9" });
    expect(readDecision({ action: "split", reasoning: "r", done_when: "manual flow" })).toMatchObject({ error: expect.stringContaining("parts") });
    expect(readDecision({ action: "split", reasoning: "r", done_when: "manual flow", parts: [{ title: "Scan", done_when: "scan prefills" }] }))
      .toEqual({ action: "split", reasoning: "r", doneWhen: "manual flow", parts: [{ title: "Scan", doneWhen: "scan prefills" }] });
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
