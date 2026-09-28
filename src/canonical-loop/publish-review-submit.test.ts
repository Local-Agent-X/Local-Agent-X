/**
 * publish-review-submit — the review op that actually runs, on the real
 * canonical loop, with the provider chain faked at the same seams as
 * verification-submit.test.ts (resolveProvider / createProviderAdapterFactory).
 *
 * Pins: the op shape (type, lane, budget, fingerprint binding, read-only belt
 * scoped to the repository); each reviewer answer (RED / AMBER / GREEN /
 * garbage) and each way a review can fail to answer (deadline, provider
 * failure) mapped to what the gate acts on — never GREEN by default; no ghost
 * op when the runtime cannot be resolved; and recall of a finished verdict
 * from the op store after a restart.
 */
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnResult } from "./adapter-contract.js";
import type { ChangeSet } from "../publish-review/change-set-types.js";

const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = mkdtempSync(join(tmpdir(), "lax-publish-review-"));
process.env.LAX_DATA_DIR = laxDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(laxDir, { recursive: true, force: true });
});

const mocks = vi.hoisted(() => ({
  resolveProvider: (..._args: unknown[]): unknown => ({ provider: "anthropic", apiKey: "key-123", model: "fake-review-model", authSource: "config" }),
  adapterFactory: null as null | (() => Adapter),
}));

vi.mock("../secrets.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrInitSecretsStore: () => ({}) as never,
}));
vi.mock("../agent-request/resolve-provider.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProvider: (...args: unknown[]) => Promise.resolve(mocks.resolveProvider(...args)),
}));
vi.mock("./provider-adapter-factory.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./provider-adapter-factory.js")>();
  return {
    ...original,
    createProviderAdapterFactory: async (...args: Parameters<typeof original.createProviderAdapterFactory>) =>
      (mocks.adapterFactory ? mocks.adapterFactory : original.createProviderAdapterFactory(...args)),
  };
});

const {
  runPublishReview, buildPublishReviewOp, recallPublishReviews, publishReviewRuntimeSessionId,
  PUBLISH_REVIEW_OP_BUDGET, _setPublishReviewDeadlineMsForTests, _resetPublishReviewRecallForTests,
} = await import("./publish-review-submit.js");
const { REVIEW_PUBLISH_OP_TYPE } = await import("./publish-review-verdict.js");
const { resetCanonicalRuntime, resetScheduler } = await import("./index.js");
const { readOp } = await import("../ops/op-store.js");
const { listOpsForSession } = await import("../ops/session-bridge.js");
const { sessionWorkRootOf } = await import("../workspace/paths.js");
// The reviewer's belt resolves from the live registry, as it does at boot.
(await import("../tools/registry-build.js")).buildToolRegistry();

afterAll(() => {
  resetCanonicalRuntime();
  resetScheduler();
});
afterEach(() => {
  mocks.adapterFactory = null;
  mocks.resolveProvider = () => ({ provider: "anthropic", apiKey: "key-123", model: "fake-review-model", authSource: "config" });
  _setPublishReviewDeadlineMsForTests(null);
});

const REPO = mkdtempSync(join(tmpdir(), "lax-publish-review-repo-"));
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

let seq = 0;
function changeSet(): ChangeSet {
  seq++;
  return {
    parts: [{
      kind: "git-push", label: "git push origin feature", repoRoot: REPO,
      refs: [{ remoteRef: "refs/heads/feature", localRef: "refs/heads/feature", status: "new", newSha: "b".repeat(40) }],
      baseLabel: "the merge-base with origin/main",
      commits: [{ sha: "b".repeat(40), subject: "add digest" }], commitsTruncated: false,
      files: [{ status: "A", path: "src/digest.ts" }],
      fileDiffs: [{ path: "src/digest.ts", text: "diff --git a/src/digest.ts b/src/digest.ts\n+export const d = 1;\n" }],
      diffTruncated: false, includesWorkingTree: false, identity: `id-${seq}`,
    }],
    unknown: [],
    fingerprint: `fp-${seq}-${process.hrtime.bigint().toString(36)}`,
  };
}

function reviewer(answer: string): Adapter {
  return {
    name: "fake-reviewer",
    version: "1",
    async runTurn(_input: unknown, report: (r: AdapterReport) => void): Promise<TurnResult> {
      report({ kind: "message_finalized", message: { messageId: "rv-0", role: "assistant", content: { text: answer } } });
      return { providerState: { adapterName: "fake-reviewer", adapterVersion: "1", providerPayload: null }, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted */ },
  };
}

function hanging(): Adapter {
  let aborted = false;
  return {
    name: "fake-hanging",
    version: "1",
    async runTurn(_input: unknown, report: (r: AdapterReport) => void): Promise<TurnResult> {
      for (let i = 0; i < 500 && !aborted; i++) await new Promise((r) => setTimeout(r, 10));
      report({ kind: "error", code: "aborted", message: "aborted", retryable: false });
      return { providerState: { adapterName: "fake-hanging", adapterVersion: "1", providerPayload: null }, terminalReason: "error" };
    },
    async abort(): Promise<void> { aborted = true; },
  };
}

function reviewOpDirs(): string[] {
  try { return readdirSync(join(laxDir, "operations")).filter((d) => d.startsWith(`op_${REVIEW_PUBLISH_OP_TYPE}`)); } catch { return []; }
}

describe("buildPublishReviewOp — the pinned op shape", () => {
  it("is a harness-authored agent-lane op bound to its change-set fingerprint", async () => {
    const set = changeSet();
    const op = await buildPublishReviewOp({ changeSet: set, sessionId: "sess-pr-shape", parentOpId: "op_chat_1" });
    expect(op.type).toBe(REVIEW_PUBLISH_OP_TYPE);
    expect(op.lane).toBe("agent");
    expect(op.parentOpId).toBe("op_chat_1");
    expect(op.taskProvenance).toBe("harness");
    expect(op.inputBindings).toEqual({ publishFingerprint: set.fingerprint });
    expect(op.contextPack.budget).toEqual(PUBLISH_REVIEW_OP_BUDGET);
    expect(PUBLISH_REVIEW_OP_BUDGET).toEqual({ maxIterations: 16, maxTokens: 250_000, maxWallTimeMs: 240_000, maxSelfEditCalls: 0 });
    expect(op.contextPack.context.agentsRules).toBe("");
    expect(op.task).toContain("VERDICT: RED | AMBER | GREEN");
  });
});

describe("runPublishReview — each answer becomes what the gate acts on", () => {
  const CASES: Array<[string, string, unknown]> = [
    ["RED", "VERDICT: RED\nred | src/digest.ts:1 | leaks | why | fix", { ok: true, verdict: "RED" }],
    ["AMBER", "VERDICT: AMBER\namber | src/digest.ts:1 | racy | why | fix", { ok: true, verdict: "AMBER" }],
    ["GREEN", "VERDICT: GREEN", { ok: true, verdict: "GREEN", findings: [] }],
    ["garbage", "I looked at it and it seems fine.", { ok: false }],
  ];
  for (const [what, answer, expected] of CASES) {
    it(`${what} → ${JSON.stringify(expected)}`, async () => {
      mocks.adapterFactory = () => reviewer(answer);
      const run = await runPublishReview({ changeSet: changeSet(), sessionId: `sess-pr-${what}` });
      expect(run.parsed).toMatchObject(expected as object);
      const op = readOp(run.opId!);
      // Own worker-scoped runtime session; the reviewer's belt is read-only.
      const descriptor = op?.runtimeDescriptor as { sessionId?: string; surface?: { tools: Array<{ name: string }>; security: { workspace: string; sessionWorkRoot?: string } } };
      expect(descriptor.sessionId).toBe(publishReviewRuntimeSessionId(run.opId!));
      expect(descriptor.surface?.tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read"]);
      expect(descriptor.surface?.security.workspace).toBe(REPO);
      // Relative paths anchored at the repository while it ran; released after.
      expect(descriptor.surface?.security.sessionWorkRoot).toBe(REPO);
      expect(sessionWorkRootOf(publishReviewRuntimeSessionId(run.opId!))).toBeUndefined();
      // Not tracked to the chat: no AGENTS card, no pending notification.
      expect(listOpsForSession(`sess-pr-${what}`)).toEqual([]);
    });
  }

  it("a review past its deadline is FAILED (cancelled), never a pass", async () => {
    mocks.adapterFactory = () => hanging();
    _setPublishReviewDeadlineMsForTests(80);
    const run = await runPublishReview({ changeSet: changeSet(), sessionId: "sess-pr-deadline" });
    expect(run.parsed).toMatchObject({ ok: false, reason: expect.stringMatching(/deadline/) });
  });

  it("a stopped turn cancels its review", async () => {
    mocks.adapterFactory = () => hanging();
    const ctl = new AbortController();
    const pending = runPublishReview({ changeSet: changeSet(), sessionId: "sess-pr-stop", signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    expect((await pending).parsed).toMatchObject({ ok: false, reason: expect.stringMatching(/stopped/) });
  });

  it("a provider that cannot be resolved is FAILED and leaves no ghost op", async () => {
    mocks.resolveProvider = () => { throw new Error("no provider configured"); };
    const before = reviewOpDirs().length;
    const run = await runPublishReview({ changeSet: changeSet(), sessionId: "sess-pr-noprov" });
    expect(run.parsed).toMatchObject({ ok: false, reason: expect.stringMatching(/could not start: no provider configured/) });
    expect(run.opId).toBeUndefined();
    expect(reviewOpDirs().length).toBe(before);
  });
});

describe("recallPublishReviews — verdicts survive a restart", () => {
  it("reads a finished verdict back from the op store, once per session", async () => {
    mocks.adapterFactory = () => reviewer("VERDICT: AMBER\namber | a.ts:1 | p | w | f");
    const set = changeSet();
    const run = await runPublishReview({ changeSet: set, sessionId: "sess-pr-recall" });
    _resetPublishReviewRecallForTests();
    const recalled = recallPublishReviews("sess-pr-recall");
    expect(recalled).toEqual([{ fingerprint: set.fingerprint, opId: run.opId, parsed: expect.objectContaining({ verdict: "AMBER" }) }]);
    expect(recallPublishReviews("sess-pr-recall")).toEqual([]); // scanned once
  });

  it("does not recall an unparseable review", async () => {
    mocks.adapterFactory = () => reviewer("not a verdict");
    await runPublishReview({ changeSet: changeSet(), sessionId: "sess-pr-recall-bad" });
    _resetPublishReviewRecallForTests();
    expect(recallPublishReviews("sess-pr-recall-bad")).toEqual([]);
  });
});
