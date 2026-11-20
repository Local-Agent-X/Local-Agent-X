import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const BASE = Date.now();
const PLAYBOOK = "## Steps\n1. Open External > Create PO.\n\n## Pitfalls\n- Never the AI import.";

describe("cross-session learning management service", () => {
  const originalDataDir = process.env.LAX_DATA_DIR;
  let root = "";
  let workspace = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lax-learning-service-"));
    workspace = join(root, "workspace");
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
    config.setRuntimeConfig({ ...config.getRuntimeConfig(), workspace });
    const { CrossSessionLearner } = await import("./learner.js");
    const { CrossSessionLearningService } = await import("./service.js");
    const drafting = await import("../../protocols/learned-review-drafting.js");
    const learner = CrossSessionLearner.getInstance();
    return { learner, drafting, service: new CrossSessionLearningService(learner) };
  }

  type System = Awaited<ReturnType<typeof system>>;

  /** A reviewed procedure proposed from one session; a different `extra`
   *  line makes a new draft version of the same procedure. */
  function propose(sys: System, sessionId: string, timestamp: number, extra = ""): string {
    const result = sys.drafting.proposeReviewedProcedure({
      name: "thriveventory_purchase_order",
      description: "Create a purchase order in Thriveventory from a supplier invoice",
      triggers: ["thriveventory purchase order"],
      body: `${PLAYBOOK}${extra ? `\n- ${extra}` : ""}`,
      outcome: "verified",
      origin: "review",
      learned: { kind: "external_string", detail: "Open External > Create PO." },
      sessionId,
      toolSequence: ["browser", "read", "write"],
      timestamp,
    });
    if (!result.ok) throw new Error(result.message);
    return result.candidateId;
  }

  function newestVersion(sys: System, id: string): string {
    return sys.service.detail(id)!.versions.at(-1)!.id;
  }

  function activate(sys: System, id: string, versionId: string, expected: string | null, now: number): void {
    sys.service.action(id, { action: "activate", versionId, expectedActiveVersionId: expected }, now);
  }

  function managedDir(id: string): string {
    return join(process.env.LAX_DATA_DIR!, "protocols", "learned", id);
  }

  async function commitOutcomes(
    slug: string,
    versionId: string,
    outcomes: Array<"clean" | "partial" | "aborted">,
    start: number,
  ): Promise<void> {
    const ledger = await import("../../protocols/learned-effectiveness.js");
    outcomes.forEach((outcome, index) => {
      const opId = `${versionId}-${start}-${index}`;
      ledger.prepareLearnedOutcome({
        opId, sessionId: `session-${opId}`, slug, versionId, candidateId: slug,
        outcome, timestamp: start + index,
      });
      ledger.commitLearnedOutcome(opId);
    });
  }

  /** A draft the retired tool-sequence tier left on disk, written the way it
   *  wrote one: a workflow-tactic candidate plus a draft record. */
  async function seedLegacyWorkflowDraft(sys: System): Promise<string> {
    const types = await import("./types.js");
    const examples = ["memory_search -> remember"];
    const description = `Workflow "general:${examples[0]}" completed cleanly 5/5 times`;
    const id = types.deriveCandidateId("workflow", description, examples);
    const candidate = {
      ...types.WORKFLOW_TACTIC_IDENTITY, id, state: "candidate", confidence: 0.8,
      suggestion: { type: "mission", name: "general workflow", description: "This sequence repeats often", config: { sequence: examples, patternType: "workflow", occurrences: 5 } },
      evidence: {
        ...types.TERMINAL_TELEMETRY_IDENTITY, patternType: "workflow", description, occurrences: 5, lastSeen: BASE, examples,
        outcomeStats: { clean: 5, partial: 0, aborted: 0, successRate: 1, weightedSuccessRate: 1, distinctSessions: 2 },
      },
      createdAt: BASE, updatedAt: BASE, transitions: [],
    };
    expect(types.hasCandidateEvidenceIdentity(candidate)).toBe(true);
    (await import("./persistence.js")).mutateData((data) => { data.candidates.push(candidate as never); });
    sys.learner.refresh();

    const body = `---\nname: ${id}\ndescription: Outcome-proven general workflow using memory_search then remember\n---\n\nmemory_search, then remember.\n`;
    const version = {
      id: randomUUID(), sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      createdAt: new Date(BASE).toISOString(),
      metadata: { ...types.WORKFLOW_TACTIC_IDENTITY, candidateId: id, allowedTools: ["memory_search", "remember"], toolSequence: ["memory_search", "remember"] },
    };
    const versionDir = join(managedDir(id), "versions", version.id);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, "SKILL.md"), body);
    writeFileSync(join(versionDir, "meta.json"), JSON.stringify(version, null, 2));
    writeFileSync(join(managedDir(id), "learned.json"), JSON.stringify({
      schemaVersion: 1, slug: id, state: "draft", activeVersionId: null, versions: [version],
    }, null, 2));
    return id;
  }

  it("returns the exact list/detail contract for a reviewed draft", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);

    expect(sys.service.reconcile(BASE + 10)).toEqual({ signals: [], changed: false });
    const item = sys.service.list()[0];
    const detail = sys.service.detail(id)!;
    expect(Object.keys(item).sort()).toEqual([
      "activeVersionId", "confidence", "id", "name", "source", "state", "updatedAt", "versionCount",
    ]);
    expect(item).toMatchObject({ id, state: "candidate", source: "reviewed", activeVersionId: null, versionCount: 1 });
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(detail).sort()).toEqual([
      "activeVersionId", "confidence", "evidence", "history", "id", "name", "source", "state", "updatedAt", "versionCount", "versions",
    ]);
    expect(detail.versions[0]).toMatchObject({ name: "Version 1", active: false });
  });

  it("never drafts: a candidate whose record is missing stays without one", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    rmSync(managedDir(id), { recursive: true, force: true });

    expect(sys.service.reconcile(BASE + 10)).toEqual({ signals: [], changed: false });
    expect(sys.service.list()[0]).toMatchObject({ id, versionCount: 0 });
    expect(existsSync(managedDir(id))).toBe(false);
  });

  it("leaves a legacy observed-workflow draft as a draft, and the user can still keep it", async () => {
    const sys = await system();
    const id = await seedLegacyWorkflowDraft(sys);

    expect(sys.service.reconcile(BASE + 10)).toEqual({ signals: [], changed: false });
    expect(sys.service.reconcile(BASE + 11)).toEqual({ signals: [], changed: false });
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    expect(lifecycle.loadLearnedProtocol(id)).toMatchObject({ state: "draft", activeVersionId: null });

    activate(sys, id, newestVersion(sys, id), null, BASE + 12);
    expect(sys.service.list()[0]).toMatchObject({ id, state: "active", source: "observed" });
  });

  it("resumes an interrupted approval, and never brings back a rejected candidate's record", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    sys.learner.setCandidateState(id, "approved", "Interrupted activation", BASE + 2);

    expect(sys.service.reconcile(BASE + 3).changed).toBe(true);
    expect(sys.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    sys.service.action(id, { action: "archive", expectedActiveVersionId: sys.service.list()[0].activeVersionId }, BASE + 4);
    sys.learner.setCandidateState(id, "candidate", "Prepare rejection", BASE + 5);
    sys.service.action(id, { action: "reject" }, BASE + 6);
    rmSync(managedDir(id), { recursive: true, force: true });

    expect(sys.service.reconcile(BASE + 7)).toEqual({ signals: [], changed: false });
    expect(sys.service.list()[0]).toMatchObject({ state: "rejected", versionCount: 0 });
    expect(existsSync(managedDir(id))).toBe(false);
  });

  it.each(["rejected", "rolled-back"] as const)("never activates an existing draft for a %s candidate, even with independent evidence", async (state) => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    propose(sys, "session-b", BASE + 2);
    propose(sys, "session-c", BASE + 3);
    if (state === "rejected") {
      sys.service.action(id, { action: "reject" }, BASE + 4);
    } else {
      sys.learner.setCandidateState(id, "approved", "Interrupted activation", BASE + 4);
      sys.learner.setCandidateState(id, "active", "Interrupted activation", BASE + 5);
      sys.learner.setCandidateState(id, "rolled-back", "Interrupted rollback", BASE + 6);
    }

    expect(sys.service.reconcile(BASE + 10)).toEqual({ signals: [], changed: false });
    expect(sys.service.list()[0]).toMatchObject({ state, activeVersionId: null, versionCount: 1 });
    expect(sys.service.reconcile(BASE + 11)).toEqual({ signals: [], changed: false });
  });

  it("enforces stale CAS and drives legal activate, archive, restore, and rollback transitions", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const first = newestVersion(sys, id);

    expect(() => activate(sys, id, first, "00000000-0000-0000-0000-000000000000", BASE + 2)).toThrow(/version changed/);
    expect(sys.service.list()[0].state).toBe("candidate");

    activate(sys, id, first, null, BASE + 3);
    expect(() => sys.service.action(id, { action: "reject" }, BASE + 4)).toThrow(/must be archived/);
    propose(sys, "session-b", BASE + 5, "Save before closing the modal.");
    const second = newestVersion(sys, id);
    expect(second).not.toBe(first);
    activate(sys, id, second, first, BASE + 6);
    sys.service.action(id, { action: "rollback", versionId: first, expectedActiveVersionId: second }, BASE + 7);

    expect(sys.service.list()[0]).toMatchObject({ state: "active", activeVersionId: first });
    expect(sys.service.detail(id)!.history.some((entry) => entry.reason === "Rolled back by user")).toBe(true);
    sys.service.action(id, { action: "archive", expectedActiveVersionId: first }, BASE + 8);
    expect(sys.service.list()[0]).toMatchObject({ state: "archived", versionCount: 2 });
    expect(sys.service.reconcile(BASE + 9)).toEqual({ signals: [], changed: false });
    expect(sys.service.list()[0]).toMatchObject({ state: "archived", versionCount: 2 });
    sys.service.action(id, { action: "restore", expectedActiveVersionId: first }, BASE + 10);
    expect(sys.service.list()[0].state).toBe("active");
  });

  it("applies hard safety rollback to the healthy prior", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const healthy = newestVersion(sys, id);
    activate(sys, id, healthy, null, BASE + 2);
    await commitOutcomes(id, healthy, ["clean", "clean", "clean", "clean", "clean"], BASE + 10);

    propose(sys, "session-b", BASE + 20, "Save before closing the modal.");
    const probationary = newestVersion(sys, id);
    activate(sys, id, probationary, healthy, BASE + 21);
    await commitOutcomes(id, probationary, ["aborted", "clean", "aborted"], BASE + 30);

    sys.service.reconcile(BASE + 40);
    expect(sys.service.list()[0]).toMatchObject({ state: "active", activeVersionId: healthy, versionCount: 2 });
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    expect(lifecycle.loadLearnedProtocol(id).activationHistory?.at(-1)).toMatchObject({
      kind: "rollback", versionId: healthy, reason: "Safety rollback: hard regression", cause: "safety",
    });
    expect(sys.service.reconcile(BASE + 41)).toEqual({ signals: [], changed: false });
  });

  it("rolls a regression back to the healthy prior, never forward to a newer draft", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const first = newestVersion(sys, id);
    activate(sys, id, first, null, BASE + 2);
    await commitOutcomes(id, first, ["clean", "clean", "clean", "clean", "clean"], BASE + 10);

    propose(sys, "session-b", BASE + 20, "Save before closing the modal.");
    const second = newestVersion(sys, id);
    activate(sys, id, second, first, BASE + 21);
    propose(sys, "session-c", BASE + 22, "Attach the invoice PDF.");
    const third = newestVersion(sys, id);
    expect(third).not.toBe(second);
    await commitOutcomes(id, second, ["aborted", "clean", "aborted"], BASE + 30);

    sys.service.reconcile(BASE + 40);
    expect(sys.service.list()[0]).toMatchObject({ activeVersionId: first, versionCount: 3 });
  });

  it("archives a regressing activation when no healthy prior exists and ignores unrelated or uncommitted events", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const active = newestVersion(sys, id);
    activate(sys, id, active, null, BASE + 2);
    const ledger = await import("../../protocols/learned-effectiveness.js");
    ledger.prepareLearnedOutcome({
      opId: "cancelled-no-commit", sessionId: "session-cancelled", slug: id, versionId: active,
      candidateId: id, outcome: "aborted", timestamp: BASE + 20,
    });
    await commitOutcomes("learned-aaaaaaaaaaaaaaaaaaaa", active, ["aborted", "aborted", "aborted"], BASE + 20);
    expect(sys.service.reconcile(BASE + 30)).toEqual({ signals: [], changed: false });

    await commitOutcomes(id, active, ["aborted", "clean", "aborted"], BASE + 40);
    sys.service.reconcile(BASE + 50);
    expect(sys.service.list()[0].state).toBe("archived");
  });

  it("fails closed on immutable active-version tampering without changing lifecycle state", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    activate(sys, id, newestVersion(sys, id), null, BASE + 2);
    const lifecyclePath = join(managedDir(id), "learned.json");
    const before = readFileSync(lifecyclePath, "utf8");
    writeFileSync(join(managedDir(id), "SKILL.md"), "tampered\n");

    expect(() => sys.service.reconcile(BASE + 20)).toThrow(/materialization mismatch/);
    expect(readFileSync(lifecyclePath, "utf8")).toBe(before);
  });

  it("uses the active version creation boundary for legacy records without activation history", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const active = newestVersion(sys, id);
    activate(sys, id, active, null, BASE + 2);
    const lifecyclePath = join(managedDir(id), "learned.json");
    const legacy = JSON.parse(readFileSync(lifecyclePath, "utf8")) as Record<string, unknown>;
    delete legacy.activationHistory;
    writeFileSync(lifecyclePath, JSON.stringify(legacy, null, 2));
    const afterCreation = Date.now() + 1_000;
    await commitOutcomes(id, active, ["aborted", "clean", "aborted"], afterCreation);

    sys.service.reconcile(afterCreation + 10);
    expect(sys.service.list()[0].state).toBe("archived");
  });

  it("resumes durable approval exactly once", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    sys.learner.setCandidateState(id, "approved", "Interrupted activation", BASE + 2);
    expect(sys.service.reconcile(BASE + 3).changed).toBe(true);
    expect(sys.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    expect(sys.service.detail(id)!.history.some((entry) => entry.to === "rejected")).toBe(false);
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const record = lifecycle.loadLearnedProtocol(id);
    expect(record.versions).toHaveLength(1);
    expect(record.activationHistory).toHaveLength(1);
    expect(record.activationHistory![0]).toMatchObject({ kind: "activate", reason: "Resumed approved activation" });

    expect(sys.service.reconcile(BASE + 4)).toEqual({ signals: [], changed: false });
    const repeated = lifecycle.loadLearnedProtocol(id);
    expect(repeated.versions).toHaveLength(1);
    expect(repeated.activationHistory).toHaveLength(1);
    expect(sys.service.detail(id)!.history.map((entry) => entry.to)).toEqual(["approved", "active"]);
  });

  it("refreshes a long-lived service before exposing another process's candidate intent", async () => {
    const first = await system();
    const id = propose(first, "session-a", BASE + 1);

    vi.resetModules();
    const second = await system();
    second.service.action(id, { action: "reject" }, BASE + 2);

    expect(first.service.list()[0].state).toBe("rejected");
    expect(first.service.detail(id)!.history.at(-1)).toMatchObject({ to: "rejected" });
  });

  it("keeps lifecycle activation authoritative when candidate projection is locked, then heals", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const historyBefore = structuredClone(sys.learner.getCandidates()[0].transitions);
    const lock = new Database(join(process.env.LAX_DATA_DIR!, "cross-session-data.json.lock.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    try {
      const activated = sys.service.action(id, { action: "activate", expectedActiveVersionId: null }, BASE + 2);
      expect(activated).toMatchObject({ state: "active", activeVersionId: expect.any(String) });
      expect(sys.learner.getCandidates()[0].state).toBe("candidate");
      sys.learner.refresh();
      expect(sys.learner.getCandidates()[0].transitions).toEqual(historyBefore);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }

    expect(sys.service.reconcile(BASE + 3).changed).toBe(true);
    expect(sys.learner.getCandidates()[0].state).toBe("active");
    expect(sys.learner.getCandidates()[0].transitions.slice(-2).map((entry) => entry.to)).toEqual(["approved", "active"]);
    expect(sys.service.reconcile(BASE + 4)).toEqual({ signals: [], changed: false });
  }, 15_000);

  it("heals one atomic rollback projection after lifecycle success under lock contention", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const firstVersion = newestVersion(sys, id);
    activate(sys, id, firstVersion, null, BASE + 2);
    propose(sys, "session-b", BASE + 3, "Save before closing the modal.");
    const secondVersion = newestVersion(sys, id);
    activate(sys, id, secondVersion, firstVersion, BASE + 4);
    const historyBefore = structuredClone(sys.learner.getCandidates()[0].transitions);
    const lock = new Database(join(process.env.LAX_DATA_DIR!, "cross-session-data.json.lock.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    try {
      sys.service.action(id, {
        action: "rollback", versionId: firstVersion, expectedActiveVersionId: secondVersion,
      }, BASE + 5);
      sys.learner.refresh();
      expect(sys.learner.getCandidates()[0].transitions).toEqual(historyBefore);
      expect(sys.service.list()[0]).toMatchObject({ state: "active", activeVersionId: firstVersion });
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }

    expect(sys.service.reconcile(BASE + 6).changed).toBe(true);
    const tail = sys.service.detail(id)!.history.slice(-4);
    expect(tail.map((entry) => entry.to)).toEqual(["rolled-back", "candidate", "approved", "active"]);
    expect(tail.map((entry) => entry.reason)).toEqual([
      "Rolled back by user", "Rollback retained active workflow", "Rollback reconciled", "Rollback reconciled",
    ]);
    expect(sys.service.reconcile(BASE + 7)).toEqual({ signals: [], changed: false });
    expect(sys.service.detail(id)!.history.slice(-4)).toEqual(tail);
  }, 15_000);

  it("heals a lifecycle-first restart exactly once without duplicate drafts or activation history", async () => {
    const first = await system();
    const id = propose(first, "session-a", BASE + 1);
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const draft = lifecycle.loadLearnedProtocol(id);
    lifecycle.activateLearnedProtocol({
      slug: id,
      versionId: draft.versions[0].id,
      expectedActiveVersionId: null,
      reason: "Lifecycle committed before projection",
      timestamp: BASE + 2,
    });

    vi.resetModules();
    const second = await system();
    expect(second.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    expect(second.service.reconcile(BASE + 3).changed).toBe(true);
    const healed = (await import("../../protocols/learned-lifecycle.js")).loadLearnedProtocol(id);
    expect(healed.versions).toHaveLength(1);
    expect(healed.activationHistory).toHaveLength(1);
    expect(second.service.reconcile(BASE + 4)).toEqual({ signals: [], changed: false });
    expect(second.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
  });

  it("uses an active lifecycle record over stale rejected candidate suppression", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    sys.service.action(id, { action: "reject" }, BASE + 2);
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const draft = lifecycle.loadLearnedProtocol(id);
    lifecycle.activateLearnedProtocol({
      slug: id,
      versionId: draft.versions[0].id,
      expectedActiveVersionId: null,
      timestamp: BASE + 3,
    });

    expect(sys.service.list()[0].state).toBe("active");
    expect(sys.service.reconcile(BASE + 4).changed).toBe(true);
    expect(sys.learner.getCandidates()[0].state).toBe("active");
  });

  it("projects lifecycle activation from the latest candidate state in one mutation", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const project = sys.learner.projectCandidateState.bind(sys.learner);
    vi.spyOn(sys.learner, "projectCandidateState").mockImplementationOnce((...args) => {
      sys.learner.setCandidateState(id, "rejected", "Concurrent rejection", BASE + 2);
      return project(...args);
    });

    sys.service.action(id, { action: "activate", expectedActiveVersionId: null }, BASE + 3);

    expect(sys.learner.getCandidates()[0].state).toBe("active");
    expect(sys.service.detail(id)!.history.slice(-4).map((entry) => entry.to)).toEqual([
      "rejected", "candidate", "approved", "active",
    ]);
  });

  it("fails a projection with no partial transition history when no legal path exists", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    sys.learner.setCandidateState(id, "approved", "Approved", BASE + 2);
    const before = sys.learner.getCandidates()[0];

    expect(() => sys.learner.projectCandidateState(id, "candidate", "Invalid recovery", BASE + 3))
      .toThrow("Approved learned workflow requires activation recovery");
    sys.learner.refresh();
    expect(sys.learner.getCandidates()[0]).toEqual(before);
  });

  it("never activates a one-session reviewed draft during repeated reconciliation", async () => {
    const sys = await system();
    const id = propose(sys, "session-a", BASE + 1);
    const lifecycle = await import("../../protocols/learned-lifecycle.js");

    expect(sys.service.reconcile(BASE + 2)).toEqual({ signals: [], changed: false });
    expect(sys.service.reconcile(BASE + 3)).toEqual({ signals: [], changed: false });
    const record = lifecycle.loadLearnedProtocol(id);
    expect(record).toMatchObject({ state: "draft", activeVersionId: null });
    expect(record.versions).toHaveLength(1);
    expect(record.activationHistory ?? []).toHaveLength(0);
  });
});
