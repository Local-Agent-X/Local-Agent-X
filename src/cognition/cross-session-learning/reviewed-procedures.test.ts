import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

const DAY = 86_400_000;
const PLAYBOOK = "## Steps\n1. Open External > Create PO.\n\n## Pitfalls\n- Never the AI import.";

describe("reviewed procedures in the learned lifecycle", () => {
  const originalDataDir = process.env.LAX_DATA_DIR;
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lax-reviewed-procedures-"));
    process.env.LAX_DATA_DIR = join(root, "data");
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = originalDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function system() {
    const config = await import("../../config.js");
    config.setRuntimeConfig({ ...config.getRuntimeConfig(), workspace: join(root, "workspace") });
    const learner = (await import("./index.js")).default;
    const { CrossSessionLearningService } = await import("./service.js");
    const drafting = await import("../../protocols/learned-review-drafting.js");
    const types = await import("./types.js");
    const protocols = await import("../../protocols/index.js");
    return { learner, service: new CrossSessionLearningService(learner), drafting, types, protocols };
  }

  type System = Awaited<ReturnType<typeof system>>;

  function propose(sys: System, sessionId: string, over: Record<string, unknown> = {}) {
    return sys.drafting.proposeReviewedProcedure({
      name: "thriveventory_purchase_order",
      description: "Create a purchase order in Thriveventory from a supplier invoice",
      triggers: ["thriveventory purchase order"],
      body: PLAYBOOK,
      outcome: "verified",
      sessionId,
      toolSequence: ["browser", "browser", "read", "write"],
      ...over,
    });
  }

  function servedNames(sys: System): string[] {
    return sys.protocols.getAllProtocols().map((p) => p.name);
  }

  describe("evidence identity", () => {
    it("accepts a reviewed-procedure candidate through every identity check that must accept it", async () => {
      const sys = await system();
      const result = propose(sys, "session-a");
      expect(result.ok).toBe(true);
      const [candidate] = sys.learner.getCandidates();
      expect(candidate).toMatchObject({ evidenceClass: "reviewed-procedure", authority: "skill-review", state: "candidate" });
      expect(sys.types.hasCandidateEvidenceIdentity(candidate)).toBe(true);
      expect(sys.types.isReviewedProcedureCandidate(candidate)).toBe(true);
      expect(sys.types.sanitizeLearnedCandidate(candidate)).toEqual(candidate);
      expect(candidate.evidence.proposals).toEqual([expect.objectContaining({ sessionId: "session-a", outcome: "verified" })]);
    });

    it("stays strict: a tampered reviewed candidate is rejected, not coerced", async () => {
      const sys = await system();
      propose(sys, "session-a");
      const [candidate] = sys.learner.getCandidates();
      const tampered = [
        { ...candidate, authority: "cross-session-learning" },
        { ...candidate, extra: true },
        { ...candidate, suggestion: { ...candidate.suggestion, name: "something_else" } },
        { ...candidate, suggestion: { ...candidate.suggestion, description: "two\nlines" } },
        { ...candidate, evidence: { ...candidate.evidence, occurrences: 2 } },
        { ...candidate, evidence: { ...candidate.evidence, proposals: [{ sessionId: "x", timestamp: 1, outcome: "approved" }] } },
        { ...candidate, evidence: { ...candidate.evidence, authority: "canonical-operation" } },
        { ...candidate, evidence: { ...candidate.evidence, outcomeStats: { clean: 1 } } },
      ];
      for (const value of tampered) {
        expect(sys.types.hasCandidateEvidenceIdentity(value)).toBe(false);
      }
      const { evidenceClass: _c, authority: _a, ...identityless } = candidate;
      expect(sys.types.hasCandidateEvidenceIdentity(identityless)).toBe(false);
    });
  });

  describe("propose drafts, never publishes", () => {
    it("creates a draft that the catalog does not serve until it is activated", async () => {
      const sys = await system();
      const result = propose(sys, "session-a");
      if (!result.ok) throw new Error(result.message);
      expect(result).toMatchObject({ created: true, drafted: true });
      expect(result.notice).toMatchObject({ id: result.candidateId, refinement: false, canReject: true, expectedActiveVersionId: null });
      expect(servedNames(sys)).not.toContain(result.candidateId);

      sys.service.action(result.candidateId, { action: "activate", versionId: result.notice!.versionId, expectedActiveVersionId: null });
      const served = sys.protocols.getAllProtocols().find((p) => p.name === result.candidateId);
      expect(served?.description).toBe("Create a purchase order in Thriveventory from a supplier invoice");
      expect(served?.triggers).toEqual(["thriveventory purchase order"]);
      expect(served?.body).toContain("# thriveventory_purchase_order");
      expect(served?.body).toContain("Never the AI import.");
      expect(served?.allowedTools).toEqual(["browser", "read", "write"]);
      expect(sys.protocols.activeLearnedProtocolProvenance(result.candidateId).allowedTools).toEqual(["browser", "read", "write"]);
    });

    it("refines an active procedure with a new draft version, never in place", async () => {
      const sys = await system();
      const first = propose(sys, "session-a");
      if (!first.ok) throw new Error(first.message);
      sys.service.action(first.candidateId, { action: "activate", versionId: first.notice!.versionId, expectedActiveVersionId: null });

      const refined = propose(sys, "session-b", { body: `${PLAYBOOK}\n- Save before closing the modal.` });
      if (!refined.ok) throw new Error(refined.message);
      expect(refined).toMatchObject({ created: false, drafted: true });
      expect(refined.notice).toMatchObject({ refinement: true, canReject: false, expectedActiveVersionId: first.notice!.versionId });
      const served = sys.protocols.getAllProtocols().find((p) => p.name === first.candidateId);
      expect(served?.body).not.toContain("Save before closing");
    });

    it("never starts a procedure from a corrected run, but lets it add a pitfall to an existing one", async () => {
      const sys = await system();
      const orphan = propose(sys, "session-a", { outcome: "corrected" });
      expect(orphan).toMatchObject({ ok: false });
      expect(sys.learner.getCandidates()).toHaveLength(0);

      propose(sys, "session-a");
      const pitfall = propose(sys, "session-b", { outcome: "corrected", body: `${PLAYBOOK}\n- The user reverted a bulk edit: confirm first.` });
      expect(pitfall).toMatchObject({ ok: true, created: false, drafted: true });
    });

    it("refuses to refine an observed tool-sequence workflow through its slug", async () => {
      const sys = await system();
      for (let index = 0; index < 3; index++) {
        sys.learner.recordOutcome({
          opId: `op-${index}`, sessionId: `s-${index}`, outcome: "clean", category: "coding",
          tools: ["read_file", "write_file"], timestamp: Date.now() + index,
        });
      }
      sys.service.reconcile("assisted");
      const observed = sys.learner.getCandidates().find((c) => c.evidenceClass === "workflow-tactic");
      expect(observed).toBeDefined();
      expect(propose(sys, "session-a", { name: observed!.id })).toMatchObject({ ok: false });
    });

    it("re-delivers a pending notice to the session that proposed it, and to no other", async () => {
      const sys = await system();
      const result = propose(sys, "session-a");
      if (!result.ok) throw new Error(result.message);
      expect(sys.drafting.pendingLearningNotices("session-a")).toEqual([result.notice]);
      expect(sys.drafting.pendingLearningNotices("session-z")).toEqual([]);
      sys.service.action(result.candidateId, { action: "reject" });
      expect(sys.drafting.pendingLearningNotices("session-a")).toEqual([]);
    });
  });

  describe("the review fork reads learned procedures without opening their capability envelope", () => {
    it("get renders drafts and live versions directly; list and search show pending procedures", async () => {
      const sys = await system();
      const result = propose(sys, "session-a");
      if (!result.ok) throw new Error(result.message);
      const { narrowProtocolToolForReview } = await import("../../server/background-jobs/skill-review-tool.js");
      const calls: Array<Record<string, unknown>> = [];
      const tool = narrowProtocolToolForReview({
        name: "protocol", description: "base", parameters: { type: "object", properties: {} },
        execute: async (args) => { calls.push(args); return { content: "CATALOG" }; },
      }, { reviewedSessionId: "session-b", toolSequence: [] });

      const byName = await tool.execute({ action: "get", params: { name: "thriveventory_purchase_order" } });
      expect(byName.content).toContain("draft, awaiting the user");
      expect(byName.content).toContain("Never the AI import.");
      sys.service.action(result.candidateId, { action: "activate", versionId: result.notice!.versionId, expectedActiveVersionId: null });
      const bySlug = await tool.execute({ action: "get", params: { name: result.candidateId } });
      expect(bySlug.content).toContain("State: active.");
      expect(calls, "learned procedures are never fetched through the catalog get").toHaveLength(0);

      propose(sys, "session-c", { body: `${PLAYBOOK}\n- Save first.` });
      const listed = await tool.execute({ action: "list", params: {} });
      expect(listed.content).toContain("CATALOG");
      expect(listed.content).toContain(`thriveventory_purchase_order (${result.candidateId})`);
      expect(listed.content).toContain("newer draft awaiting the user");
      expect((await tool.execute({ action: "search", params: { query: "thriveventory invoice" } })).content).toContain(result.candidateId);
      expect((await tool.execute({ action: "search", params: { query: "calendar booking" } })).content).not.toContain(result.candidateId);
    });
  });

  describe("promotion: the user's OK, or independent evidence — never autonomous mode", () => {
    it("autonomous mode does not activate a reviewed draft", async () => {
      const sys = await system();
      const result = propose(sys, "session-a");
      if (!result.ok) throw new Error(result.message);
      sys.service.reconcile("autonomous");
      sys.service.reconcile("autonomous");
      expect(sys.service.detail(result.candidateId)).toMatchObject({ state: "candidate", activeVersionId: null, source: "reviewed" });
      expect(servedNames(sys)).not.toContain(result.candidateId);
    });

    it("activates once three distinct sessions independently proposed it from runs that held up", async () => {
      const sys = await system();
      const first = propose(sys, "session-a");
      if (!first.ok) throw new Error(first.message);
      propose(sys, "session-a");
      propose(sys, "session-b");
      sys.service.reconcile("assisted");
      expect(sys.service.detail(first.candidateId)?.state).toBe("candidate");

      propose(sys, "session-c");
      const { signals } = sys.service.reconcile("assisted");
      expect(sys.service.detail(first.candidateId)).toMatchObject({ state: "active" });
      expect(signals).toEqual([expect.objectContaining({ category: "learning-activity" })]);
      expect(servedNames(sys)).toContain(first.candidateId);
    });

    it("does not count sessions whose run was reverted or corrected", async () => {
      const sys = await system();
      const first = propose(sys, "session-a");
      if (!first.ok) throw new Error(first.message);
      propose(sys, "session-b");
      propose(sys, "session-b", { outcome: "corrected" });
      propose(sys, "session-c");
      sys.service.reconcile("assisted");
      expect(sys.service.detail(first.candidateId)?.state).toBe("candidate");

      propose(sys, "session-d");
      sys.service.reconcile("assisted");
      expect(sys.service.detail(first.candidateId)?.state).toBe("active");
    });

    it("refuses to activate a reviewed version that carries no tool evidence", async () => {
      const sys = await system();
      const result = propose(sys, "session-a", { toolSequence: [], outcome: "unverified" });
      if (!result.ok) throw new Error(result.message);
      expect(() => sys.service.action(result.candidateId, { action: "activate", expectedActiveVersionId: null }))
        .toThrow(/no tool evidence/);
    });

    it("a discarded procedure stays discarded for its cooldown, then may be proposed afresh", async () => {
      const sys = await system();
      const now = Date.now();
      const result = propose(sys, "session-a", { timestamp: now });
      if (!result.ok) throw new Error(result.message);
      sys.service.action(result.candidateId, { action: "reject" }, now + 1);
      expect(propose(sys, "session-b", { timestamp: now + 2 })).toMatchObject({ ok: false });

      const later = propose(sys, "session-c", { timestamp: now + 31 * DAY });
      expect(later).toMatchObject({ ok: true });
      const revived = sys.service.detail(result.candidateId)!;
      expect(revived.state).toBe("candidate");
      expect(revived.evidence.proposals).toEqual([expect.objectContaining({ sessionId: "session-c" })]);
    });
  });

  describe("Keep and Discard through the existing learning route", () => {
    function request(body: unknown) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
      req.headers = {};
      return req;
    }
    function response() {
      const res = {
        statusCode: 0, body: "",
        writeHead(status: number) { res.statusCode = status; return res; },
        end(chunk?: string) { if (chunk) res.body = chunk; return res; },
      };
      return res;
    }
    async function post(id: string, body: unknown) {
      const { handleMemoryLearningRoutes } = await import("../../routes/memory-learning.js");
      const res = response();
      const broadcastAll = vi.fn();
      await handleMemoryLearningRoutes(
        "POST",
        new URL(`http://127.0.0.1/api/memory/learning/${id}/action`),
        request(body) as unknown as Parameters<typeof handleMemoryLearningRoutes>[2],
        res as unknown as Parameters<typeof handleMemoryLearningRoutes>[3],
        { broadcastAll } as unknown as Parameters<typeof handleMemoryLearningRoutes>[4],
        "operator",
      );
      return { status: res.statusCode, body: JSON.parse(res.body) as { item?: { state: string; activeVersionId: string | null } }, broadcastAll };
    }

    it("Keep posts activate for the proposed version and the procedure goes live", async () => {
      const sys = await system();
      const result = propose(sys, "session-a");
      if (!result.ok) throw new Error(result.message);
      const notice = result.notice!;
      const kept = await post(notice.id, { action: "activate", versionId: notice.versionId, expectedActiveVersionId: notice.expectedActiveVersionId });
      expect(kept.status).toBe(200);
      expect(kept.body.item).toMatchObject({ state: "active", activeVersionId: notice.versionId });
      expect(kept.broadcastAll).toHaveBeenCalledWith({ type: "learning_changed", id: notice.id, action: "activate" });
      expect(servedNames(sys)).toContain(notice.id);
    });

    it("Discard posts reject and the procedure is never served", async () => {
      const sys = await system();
      const result = propose(sys, "session-a");
      if (!result.ok) throw new Error(result.message);
      const discarded = await post(result.candidateId, { action: "reject" });
      expect(discarded.status).toBe(200);
      expect(discarded.body.item).toMatchObject({ state: "rejected", activeVersionId: null });
      sys.service.reconcile("autonomous");
      expect(servedNames(sys)).not.toContain(result.candidateId);
    });
  });
});
