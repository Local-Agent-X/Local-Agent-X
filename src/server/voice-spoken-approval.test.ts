import { describe, it, expect } from "vitest";
import { ASK_AGAIN, approvalQuestion, classifySpokenAnswer, createSpokenApprovals, type SpokenApprovalDeps } from "./voice-spoken-approval.js";

describe("classifySpokenAnswer", () => {
  it.each(["Yes.", "yeah", "Yep, go ahead", "Sure, send it", "OK do it", "yes please", "Go for it", "Sounds good"])("%s is a yes", (text) => {
    expect(classifySpokenAnswer(text)).toBe("yes");
  });

  it.each(["No.", "nope", "Don't send it", "Cancel that", "wait", "hold on", "not yet"])("%s is a no", (text) => {
    expect(classifySpokenAnswer(text)).toBe("no");
  });

  it.each([
    "yes but change the subject first",
    "what is it going to say",
    "no wait yes",
    "yeah send it to my wife and also my brother and my mom",
    "right",
  ])("%s is unclear", (text) => {
    expect(classifySpokenAnswer(text)).toBe("unclear");
  });
});

describe("approvalQuestion", () => {
  it("asks about the call's own approval line, not the model's words", () => {
    expect(approvalQuestion("Send email to bob@example.com: \"Notes\".")).toBe(' That needs your OK: Send email to bob@example.com: "Notes". Should I go ahead?');
  });

  it("cuts a long line", () => {
    const q = approvalQuestion(`Run command: "${"x".repeat(400)}"`);
    expect(q.length).toBeLessThan(220);
    expect(q).toContain("…");
  });
});

/** A spoken-approval setup whose answers come from `answers`, in order. */
function setup(answers: Array<string | null>, overrides: Partial<SpokenApprovalDeps> = {}) {
  const spoken: string[] = [];
  const resolved: Array<[string, boolean]> = [];
  const turn = new AbortController();
  let settle!: () => void;
  const done = new Promise<void>((r) => { settle = r; });
  const deps: SpokenApprovalDeps = {
    speak: (line) => spoken.push(line),
    awaitAnswer: async () => answers.shift() ?? null,
    turnSignal: turn.signal,
    log: () => {},
    resolve: (id, approved) => { resolved.push([id, approved]); settle(); return true; },
    ...overrides,
  };
  const approvals = createSpokenApprovals(deps);
  return { spoken, resolved, turn, done, approvals };
}

const ASK = { approvalId: "apr-1", context: "Send email to bob@example.com", toolName: "email_send" };

describe("createSpokenApprovals", () => {
  it("asks out loud and a yes approves the call", async () => {
    const s = setup(["yes go ahead"]);
    s.approvals.requested(ASK);
    await s.done;
    expect(s.spoken).toEqual([approvalQuestion(ASK.context)]);
    expect(s.resolved).toEqual([["apr-1", true]]);
  });

  it("a no declines it", async () => {
    const s = setup(["no don't"]);
    s.approvals.requested(ASK);
    await s.done;
    expect(s.resolved).toEqual([["apr-1", false]]);
  });

  it("an unclear answer is asked once more", async () => {
    const s = setup(["what will it say", "yes"]);
    s.approvals.requested(ASK);
    await s.done;
    expect(s.spoken).toEqual([approvalQuestion(ASK.context), ASK_AGAIN]);
    expect(s.resolved).toEqual([["apr-1", true]]);
  });

  it("two unclear answers decline", async () => {
    const s = setup(["hmm", "maybe later"]);
    s.approvals.requested(ASK);
    await s.done;
    expect(s.resolved).toEqual([["apr-1", false]]);
  });

  it("silence declines", async () => {
    const s = setup([null]);
    s.approvals.requested(ASK);
    await s.done;
    expect(s.resolved).toEqual([["apr-1", false]]);
  });

  it("a session with nobody to answer declines without asking", async () => {
    const s = setup([], { awaitAnswer: undefined });
    s.approvals.requested(ASK);
    await s.done;
    expect(s.spoken).toEqual([]);
    expect(s.resolved).toEqual([["apr-1", false]]);
  });

  it("an ask answered elsewhere stops waiting, and a late yes approves nothing", async () => {
    let cancelSignal!: AbortSignal;
    let answer!: (text: string | null) => void;
    const s = setup([], {
      awaitAnswer: (_ms, cancel) => { cancelSignal = cancel; return new Promise((r) => { answer = r; }); },
    });
    s.approvals.requested(ASK);
    await Promise.resolve();
    s.approvals.settled("apr-1");
    expect(cancelSignal.aborted).toBe(true);
    answer("yes");
    await s.done;
    expect(s.resolved).toEqual([["apr-1", false]]);
  });

  it("a turn that ends while waiting is not a yes", async () => {
    let answer!: (text: string | null) => void;
    const s = setup([], { awaitAnswer: () => new Promise((r) => { answer = r; }) });
    s.approvals.requested(ASK);
    await Promise.resolve();
    s.turn.abort();
    answer("yes");
    await s.done;
    expect(s.resolved).toEqual([["apr-1", false]]);
  });
});
