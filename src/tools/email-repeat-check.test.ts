// The repeat check before a send: back-and-forth is never asked about, the same
// message again to someone who has not answered is, and a model decides
// between "the same thing again" and "something new" only after code has
// found such a candidate.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeEmail, emailFingerprint, type ComposedEmail } from "./email-send-tool.js";
import { recordSent } from "./email-sent-log.js";
import { repeatSendReason, type RepeatCheckDeps } from "./email-repeat-check.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-repeat-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const JOB = "<offer-1@company.com>";

function draft(args: Record<string, unknown>): ComposedEmail {
  const c = composeEmail({ to: "jobs@company.com", subject: "Line cook position", ...args });
  if ("error" in c) throw new Error(c.error);
  return c;
}

function sent(args: Record<string, unknown>, at = Date.now() - 12 * 60_000): ComposedEmail {
  const c = draft(args);
  recordSent({ at, recipients: ["jobs@company.com"], subject: c.subject, text: c.text, messageId: "<mine-1@me.com>", inReplyTo: c.inReplyTo, fingerprint: emailFingerprint(c) });
  return c;
}

function deps(over: Partial<RepeatCheckDeps> = {}): RepeatCheckDeps & { judge: ReturnType<typeof vi.fn> } {
  return {
    repliedSince: async () => false,
    judge: vi.fn(async () => ({ verdict: "same" as const, why: "Both accept the Thursday interview." })),
    ...over,
  } as RepeatCheckDeps & { judge: ReturnType<typeof vi.fn> };
}

const check = (c: ComposedEmail, d: RepeatCheckDeps) => repeatSendReason(c, emailFingerprint(c), d);

describe("repeat check before a send", () => {
  it("a first email to someone sends without a question or a model call", async () => {
    const d = deps();
    expect(await check(draft({ body: "Hi, I'd love to interview Thursday." }), d)).toBeNull();
    expect(d.judge).not.toHaveBeenCalled();
  });

  it("the same reply reworded, to someone who has not answered, asks — naming what already went", async () => {
    sent({ in_reply_to: JOB, body: "Thanks! Thursday at 2 works for the interview." });
    const d = deps();
    const reason = await check(draft({ in_reply_to: JOB, body: "Thank you, I can come Thursday at 2pm." }), d);
    expect(reason).toContain("already emailed jobs@company.com 12 min ago");
    expect(reason).toContain("Thanks! Thursday at 2 works");
    expect(reason).toContain("Both accept the Thursday interview");
    expect(d.judge).toHaveBeenCalledOnce();
  });

  it("something new to the same person sends", async () => {
    sent({ body: "Thanks! Thursday at 2 works." });
    const d = deps({ judge: vi.fn(async () => ({ verdict: "new" as const, why: "Adds the resume." })) });
    expect(await check(draft({ body: "Forgot to attach my resume, here it is." }), d)).toBeNull();
  });

  it("back-and-forth: once they replied, the next email is an answer and no model is asked", async () => {
    sent({ body: "Thanks! Thursday at 2 works." });
    const d = deps({ repliedSince: async () => true });
    expect(await check(draft({ body: "Great, see you then." }), d)).toBeNull();
    expect(d.judge).not.toHaveBeenCalled();
  });

  it("a reply to a different message of theirs is a conversation, not a repeat", async () => {
    sent({ in_reply_to: JOB, body: "Thanks! Thursday at 2 works." });
    const d = deps({ repliedSince: async () => null });
    expect(await check(draft({ in_reply_to: "<their-answer-2@company.com>", body: "Perfect." }), d)).toBeNull();
    expect(d.judge).not.toHaveBeenCalled();
  });

  it("an identical email asks without a model call", async () => {
    const first = sent({ body: "Thanks! Thursday at 2 works." });
    const d = deps();
    expect(await check(first, d)).toContain("identical");
    expect(d.judge).not.toHaveBeenCalled();
  });

  it("when the model cannot answer, it asks rather than risk sending twice", async () => {
    sent({ body: "Thanks! Thursday at 2 works." });
    expect(await check(draft({ body: "Thursday is good." }), deps({ judge: vi.fn(async () => null) }))).toContain("could not run");
  });

  it("an email from before the window is not compared", async () => {
    sent({ body: "Thanks! Thursday at 2 works." }, Date.now() - 3 * 24 * 60 * 60_000);
    const d = deps();
    expect(await check(draft({ body: "Thanks! Thursday at 2 works." }), d)).toBeNull();
  });

  it("through the pipeline, a repeat raises the approval card even under the most permissive profile", async () => {
    const { emailSend } = await import("./email-send-tool.js");
    const { toolConfirmationGate } = await import("../tool-execution/ask-user-gates.js");
    const { requireApprovalPhase } = await import("../tool-execution/require-approval.js");
    const { setSessionProfile, clearSessionProfile } = await import("../autonomy/profile-store.js");
    const { getApprovalManager } = await import("../approval-manager.js");
    const args = { to: "jobs@company.com", subject: "Line cook position", body: "Thanks! Thursday at 2 works." };
    sent(args);
    const sessionId = `repeat-${Math.random().toString(36).slice(2)}`;
    setSessionProfile(sessionId, "Autonomous");
    const events: Array<{ type: string; approvalId?: string; context?: string }> = [];
    const c = {
      tc: { id: "tc-send", name: "email_send", arguments: JSON.stringify(args) },
      tool: emailSend, sessionId, callContext: "local", args, priorMessages: [{ role: "user", content: "send it" }],
      onEvent: (e: { type: string; approvalId?: string }) => {
        events.push(e);
        if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId!, false);
      },
      approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
    } as unknown as Parameters<typeof requireApprovalPhase>[0];
    try {
      await toolConfirmationGate(c);
      const outcome = await requireApprovalPhase(c);
      const card = events.find((e) => e.type === "approval_requested");
      expect(card?.context).toContain("already emailed jobs@company.com");
      expect(outcome.kind).toBe("halt");
      expect(c.result?.status).toBe("declined");
    } finally { clearSessionProfile(sessionId); }
  });

  it("a recipient in cc counts as the same person", async () => {
    sent({ body: "Thanks! Thursday at 2 works." });
    expect(await check(draft({ to: "hr@company.com", cc: "Jobs <JOBS@company.com>", body: "Thursday at 2 is fine." }), deps())).toContain("jobs@company.com");
  });
});
