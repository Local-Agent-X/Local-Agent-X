import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const DAY = 86_400_000;
const BASE = Date.now();

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
    const learner = CrossSessionLearner.getInstance();
    return { learner, service: new CrossSessionLearningService(learner) };
  }

  function addEvidence(learner: Awaited<ReturnType<typeof system>>["learner"], count = 3): void {
    for (let index = 0; index < count; index++) {
      learner.recordOutcome({
        opId: `op-${index}`,
        sessionId: `session-${index}`,
        outcome: "clean",
        category: "coding",
        tools: ["read_file", "write_file", "run_tests"],
        timestamp: BASE + index,
      });
    }
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

  it("creates one assisted draft and returns the exact list/detail contract", async () => {
    const { learner, service } = await system();
    addEvidence(learner);

    const first = service.reconcile("assisted", BASE + 10);
    const repeated = service.reconcile("assisted", BASE + 11);
    const item = service.list()[0];
    const detail = service.detail(item.id)!;

    expect(first).toMatchObject({ changed: true, signals: [{ category: "learning-candidate", priority: 3 }] });
    expect(repeated).toEqual({ signals: [], changed: false });
    expect(Object.keys(item).sort()).toEqual([
      "activeVersionId", "confidence", "id", "name", "state", "updatedAt", "versionCount",
    ]);
    expect(item).toMatchObject({ state: "candidate", activeVersionId: null, versionCount: 1 });
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(detail).sort()).toEqual([
      "activeVersionId", "confidence", "evidence", "history", "id", "name", "state", "updatedAt", "versionCount", "versions",
    ]);
    expect(detail.versions[0]).toMatchObject({ name: "Version 1", active: false });
  });

  it("activates autonomously, survives restart, and advances only to stronger evidence", async () => {
    let current = await system();
    addEvidence(current.learner);
    const first = current.service.reconcile("autonomous", BASE + 10);
    const originalVersion = current.service.list()[0].activeVersionId;
    const originalEvidence = current.learner.getCandidates()[0].evidence;

    expect(first.signals[0]).toMatchObject({ category: "learning-activity", priority: 1 });
    expect(current.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    expect(current.service.reconcile("autonomous", BASE + 11)).toEqual({ signals: [], changed: false });

    vi.resetModules();
    current = await system();
    expect(current.service.list()[0]).toMatchObject({ state: "active", activeVersionId: originalVersion });
    expect(current.service.reconcile("autonomous", BASE + 12)).toEqual({ signals: [], changed: false });

    addEvidence(current.learner, 6);
    const stronger = current.service.reconcile("autonomous", BASE + 8 * DAY);
    expect(stronger.signals[0]).toMatchObject({ category: "learning-activity", priority: 1 });
    expect(current.service.list()[0].versionCount).toBe(2);
    expect(current.service.list()[0].activeVersionId).not.toBe(originalVersion);
    expect(current.learner.getCandidates()[0].evidence).toEqual(originalEvidence);
  });

  it("reconstructs missing managed records without changing canonical intent", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;

    rmSync(managedDir(id), { recursive: true, force: true });
    expect(service.reconcile("assisted", BASE + 11).changed).toBe(true);
    expect(service.list()[0]).toMatchObject({ state: "candidate", versionCount: 1 });
    expect(service.reconcile("assisted", BASE + 12)).toEqual({ signals: [], changed: false });

    service.action(id, { action: "activate", expectedActiveVersionId: null }, BASE + 13);
    service.action(id, {
      action: "archive", expectedActiveVersionId: service.list()[0].activeVersionId,
    }, BASE + 14);
    rmSync(managedDir(id), { recursive: true, force: true });
    expect(service.reconcile("autonomous", BASE + 15)).toEqual({ signals: [], changed: true });
    expect(service.list()[0]).toMatchObject({ state: "archived", versionCount: 1 });
    expect(service.reconcile("autonomous", BASE + 16)).toEqual({ signals: [], changed: false });
  });

  it("resumes approved activation but never reconstructs a rejected candidate", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;
    learner.setCandidateState(id, "approved", "Interrupted activation", BASE + 11);
    rmSync(managedDir(id), { recursive: true, force: true });

    expect(service.reconcile("assisted", BASE + 12).changed).toBe(true);
    expect(service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    service.action(id, { action: "archive", expectedActiveVersionId: service.list()[0].activeVersionId }, BASE + 13);
    learner.setCandidateState(id, "candidate", "Prepare rejection", BASE + 14);
    service.action(id, { action: "reject" }, BASE + 15);
    rmSync(managedDir(id), { recursive: true, force: true });

    expect(service.reconcile("autonomous", BASE + 16)).toEqual({ signals: [], changed: false });
    expect(service.list()[0]).toMatchObject({ state: "rejected", versionCount: 0 });
    expect(existsSync(managedDir(id))).toBe(false);
  });

  it.each(["rejected", "rolled-back"] as const)("never activates an existing draft for a %s candidate", async (state) => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;
    if (state === "rejected") {
      service.action(id, { action: "reject" }, BASE + 11);
    } else {
      learner.setCandidateState(id, "approved", "Interrupted activation", BASE + 11);
      learner.setCandidateState(id, "active", "Interrupted activation", BASE + 12);
      learner.setCandidateState(id, "rolled-back", "Interrupted rollback", BASE + 13);
    }

    expect(service.reconcile("autonomous", BASE + 14)).toEqual({ signals: [], changed: false });
    expect(service.list()[0]).toMatchObject({ state, activeVersionId: null, versionCount: 1 });
    expect(service.reconcile("autonomous", BASE + 15)).toEqual({ signals: [], changed: false });
  });

  it("enforces stale CAS and drives legal activate, archive, restore, and rollback transitions", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;

    expect(() => service.action(id, {
      action: "activate", expectedActiveVersionId: "00000000-0000-0000-0000-000000000000",
    }, BASE + 20)).toThrow(/version changed/);
    expect(service.list()[0].state).toBe("candidate");

    service.action(id, { action: "activate", expectedActiveVersionId: null }, BASE + 21);
    const firstVersion = service.list()[0].activeVersionId!;
    expect(() => service.action(id, { action: "reject" }, BASE + 22)).toThrow(/must be archived/);
    addEvidence(learner, 6);
    service.reconcile("assisted", BASE + 8 * DAY);
    const secondVersion = service.detail(id)!.versions.at(-1)!.id;
    service.action(id, { action: "activate", versionId: secondVersion, expectedActiveVersionId: firstVersion }, BASE + 8 * DAY + 1);
    service.action(id, { action: "rollback", versionId: firstVersion, expectedActiveVersionId: secondVersion }, BASE + 8 * DAY + 2);

    expect(service.list()[0]).toMatchObject({ state: "active", activeVersionId: firstVersion });
    expect(service.detail(id)!.history.some((entry) => entry.reason === "Rolled back by user")).toBe(true);
    service.action(id, { action: "archive", expectedActiveVersionId: firstVersion }, BASE + 8 * DAY + 3);
    expect(service.list()[0].state).toBe("archived");
    const archivedVersions = service.list()[0].versionCount;
    addEvidence(learner, 5);
    expect(service.reconcile("autonomous", BASE + 16 * DAY)).toEqual({ signals: [], changed: false });
    expect(service.list()[0]).toMatchObject({ state: "archived", versionCount: archivedVersions });
    service.action(id, { action: "restore", expectedActiveVersionId: firstVersion }, BASE + 8 * DAY + 4);
    expect(service.list()[0].state).toBe("active");
  });

  it("activates an assisted-drafted safe refinement autonomously after restart and cooldown", async () => {
    let current = await system();
    addEvidence(current.learner);
    current.service.reconcile("autonomous", BASE + 10);
    const firstVersion = current.service.list()[0].activeVersionId;

    addEvidence(current.learner, 6);
    current.service.reconcile("assisted", BASE + 8 * DAY);
    const secondVersion = current.service.detail(current.service.list()[0].id)!.versions.at(-1)!.id;
    expect(current.service.list()[0]).toMatchObject({ activeVersionId: firstVersion, versionCount: 2, state: "active" });

    vi.resetModules();
    current = await system();
    const activated = current.service.reconcile("autonomous", BASE + 8 * DAY + 1);
    expect(activated.signals).toEqual([expect.objectContaining({ category: "learning-activity", priority: 1 })]);
    expect(current.service.list()[0]).toMatchObject({ activeVersionId: secondVersion, versionCount: 2, state: "active" });
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    expect(lifecycle.loadLearnedProtocol(current.service.list()[0].id).activationHistory?.at(-1)).toMatchObject({
      kind: "activate", versionId: secondVersion, previousVersionId: firstVersion,
      reason: "Activated stronger refinement automatically",
    });
    expect(current.service.reconcile("autonomous", BASE + 8 * DAY + 2)).toEqual({ signals: [], changed: false });
  });

  it("rejects a weak pre-policy inactive version without mutating the active record", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const active = service.list()[0].activeVersionId!;
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const record = lifecycle.loadLearnedProtocol(id);
    const metadata = structuredClone(record.versions[0].metadata) as Record<string, unknown>;
    metadata.confidence = 0.80;
    lifecycle.createLearnedProtocolDraft({
      slug: id,
      skillMd: readFileSync(join(managedDir(id), "SKILL.md"), "utf8"),
      metadata,
    });
    const before = readFileSync(join(managedDir(id), "learned.json"), "utf8");

    expect(service.reconcile("autonomous", BASE + 20)).toEqual({ signals: [], changed: false });
    expect(service.list()[0].activeVersionId).toBe(active);
    expect(readFileSync(join(managedDir(id), "learned.json"), "utf8")).toBe(before);
  });

  it("fails closed on a tampered inactive refinement without changing the active selection", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const first = service.list()[0].activeVersionId;
    addEvidence(learner, 6);
    service.reconcile("assisted", BASE + 8 * DAY);
    const target = service.detail(id)!.versions.at(-1)!.id;
    const lifecyclePath = join(managedDir(id), "learned.json");
    const before = readFileSync(lifecyclePath, "utf8");
    writeFileSync(join(managedDir(id), "versions", target, "meta.json"), "{}\n");

    expect(() => service.reconcile("autonomous", BASE + 8 * DAY + 1)).toThrow(/hash mismatch/);
    expect(readFileSync(lifecyclePath, "utf8")).toBe(before);
    expect(JSON.parse(before)).toMatchObject({ activeVersionId: first });
  });

  it.each(["assisted", "autonomous"] as const)("applies hard safety rollback in %s mode", async (mode) => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const healthy = service.list()[0].activeVersionId!;
    await commitOutcomes(id, healthy, ["clean", "clean", "clean", "clean", "clean"], BASE + 20);

    addEvidence(learner, 6);
    service.reconcile("autonomous", BASE + 8 * DAY);
    const probationary = service.list()[0].activeVersionId!;
    await commitOutcomes(id, probationary, ["aborted", "clean", "aborted"], BASE + 8 * DAY + 10);

    service.reconcile(mode, BASE + 8 * DAY + 20);
    expect(service.list()[0]).toMatchObject({ state: "active", activeVersionId: healthy, versionCount: 2 });
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    expect(lifecycle.loadLearnedProtocol(id).activationHistory?.at(-1)).toMatchObject({
      kind: "rollback", versionId: healthy, reason: "Safety rollback: hard regression",
    });
    expect(service.reconcile(mode, BASE + 8 * DAY + 21)).toEqual({ signals: [], changed: false });
  });

  it("rolls back an active regression instead of forward-activating a safe inactive draft", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const first = service.list()[0].activeVersionId!;
    await commitOutcomes(id, first, ["clean", "clean", "clean", "clean", "clean"], BASE + 20);

    addEvidence(learner, 6);
    service.reconcile("assisted", BASE + 8 * DAY);
    const second = service.detail(id)!.versions.at(-1)!.id;
    service.action(id, { action: "activate", versionId: second, expectedActiveVersionId: first }, BASE + 8 * DAY + 1);
    addEvidence(learner, 9);
    service.reconcile("assisted", BASE + 16 * DAY);
    const third = service.detail(id)!.versions.at(-1)!.id;
    expect(third).not.toBe(second);
    await commitOutcomes(id, second, ["aborted", "clean", "aborted"], BASE + 8 * DAY + 10);

    service.reconcile("autonomous", BASE + 16 * DAY + 1);
    expect(service.list()[0]).toMatchObject({ activeVersionId: first, versionCount: 3 });
    expect(service.list()[0].activeVersionId).not.toBe(third);
  });

  it("archives a regressing activation when no healthy prior exists and ignores unrelated or uncommitted events", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const active = service.list()[0].activeVersionId!;
    const ledger = await import("../../protocols/learned-effectiveness.js");
    ledger.prepareLearnedOutcome({
      opId: "cancelled-no-commit", sessionId: "session-cancelled", slug: id, versionId: active,
      candidateId: id, outcome: "aborted", timestamp: BASE + 20,
    });
    await commitOutcomes("learned-aaaaaaaaaaaaaaaaaaaa", active, ["aborted", "aborted", "aborted"], BASE + 20);
    expect(service.reconcile("assisted", BASE + 30)).toEqual({ signals: [], changed: false });

    await commitOutcomes(id, active, ["aborted", "clean", "aborted"], BASE + 40);
    service.reconcile("assisted", BASE + 50);
    expect(service.list()[0].state).toBe("archived");
  });

  it("fails closed on immutable active-version tampering without changing lifecycle state", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const lifecyclePath = join(managedDir(id), "learned.json");
    const before = readFileSync(lifecyclePath, "utf8");
    writeFileSync(join(managedDir(id), "SKILL.md"), "tampered\n");

    expect(() => service.reconcile("assisted", BASE + 20)).toThrow(/materialization mismatch/);
    expect(readFileSync(lifecyclePath, "utf8")).toBe(before);
  });

  it("uses the active version creation boundary for legacy records without activation history", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const active = service.list()[0].activeVersionId!;
    const lifecyclePath = join(managedDir(id), "learned.json");
    const legacy = JSON.parse(readFileSync(lifecyclePath, "utf8")) as Record<string, unknown>;
    delete legacy.activationHistory;
    writeFileSync(lifecyclePath, JSON.stringify(legacy, null, 2));
    const afterCreation = Date.now() + 1_000;
    await commitOutcomes(id, active, ["aborted", "clean", "aborted"], afterCreation);

    service.reconcile("assisted", afterCreation + 10);
    expect(service.list()[0].state).toBe("archived");
  });

  it.each(["assisted", "autonomous"] as const)("resumes durable approval exactly once in %s mode", async (mode) => {
    const first = await system();
    addEvidence(first.learner);
    first.service.reconcile("assisted", BASE + 10);
    const id = first.service.list()[0].id;
    first.learner.setCandidateState(id, "approved", "Interrupted activation", BASE + 11);
    expect(first.service.reconcile(mode, BASE + 12).changed).toBe(true);
    expect(first.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    expect(first.service.detail(id)!.history.some((entry) => entry.to === "rejected")).toBe(false);
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const record = lifecycle.loadLearnedProtocol(id);
    expect(record.versions).toHaveLength(1);
    expect(record.activationHistory).toHaveLength(1);
    expect(record.activationHistory![0]).toMatchObject({ kind: "activate", reason: "Resumed approved activation" });

    expect(first.service.reconcile(mode, BASE + 13)).toEqual({ signals: [], changed: false });
    const repeated = lifecycle.loadLearnedProtocol(id);
    expect(repeated.versions).toHaveLength(1);
    expect(repeated.activationHistory).toHaveLength(1);
    expect(first.service.detail(id)!.history.map((entry) => entry.to)).toEqual(["approved", "active"]);
  });

  it("refreshes a long-lived service before exposing another process's candidate intent", async () => {
    const first = await system();
    addEvidence(first.learner);
    first.service.reconcile("assisted", BASE + 10);
    const id = first.service.list()[0].id;

    vi.resetModules();
    const second = await system();
    second.service.action(id, { action: "reject" }, BASE + 11);

    expect(first.service.list()[0].state).toBe("rejected");
    expect(first.service.detail(id)!.history.at(-1)).toMatchObject({ to: "rejected" });
  });

  it("keeps lifecycle activation authoritative when candidate projection is locked, then heals", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;
    const historyBefore = structuredClone(learner.getCandidates()[0].transitions);
    const lockPath = join(process.env.LAX_DATA_DIR!, "cross-session-data.json.lock.sqlite");
    const lock = new Database(lockPath);
    lock.exec("BEGIN IMMEDIATE");
    try {
      const activated = service.action(id, { action: "activate", expectedActiveVersionId: null }, BASE + 11);
      expect(activated).toMatchObject({ state: "active", activeVersionId: expect.any(String) });
      expect(learner.getCandidates()[0].state).toBe("candidate");
      learner.refresh();
      expect(learner.getCandidates()[0].transitions).toEqual(historyBefore);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }

    expect(service.reconcile("assisted", BASE + 12).changed).toBe(true);
    expect(learner.getCandidates()[0].state).toBe("active");
    expect(learner.getCandidates()[0].transitions.slice(-2).map((entry) => entry.to)).toEqual(["approved", "active"]);
    expect(service.reconcile("assisted", BASE + 13)).toEqual({ signals: [], changed: false });
  }, 15_000);

  it("heals one atomic rollback projection after lifecycle success under lock contention", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const firstVersion = service.list()[0].activeVersionId!;
    addEvidence(learner, 6);
    service.reconcile("assisted", BASE + 8 * DAY);
    const secondVersion = service.detail(id)!.versions.at(-1)!.id;
    service.action(id, {
      action: "activate", versionId: secondVersion, expectedActiveVersionId: firstVersion,
    }, BASE + 8 * DAY + 1);
    const historyBefore = structuredClone(learner.getCandidates()[0].transitions);
    const lock = new Database(join(process.env.LAX_DATA_DIR!, "cross-session-data.json.lock.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    try {
      service.action(id, {
        action: "rollback", versionId: firstVersion, expectedActiveVersionId: secondVersion,
      }, BASE + 8 * DAY + 2);
      learner.refresh();
      expect(learner.getCandidates()[0].transitions).toEqual(historyBefore);
      expect(service.list()[0]).toMatchObject({ state: "active", activeVersionId: firstVersion });
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }

    expect(service.reconcile("assisted", BASE + 8 * DAY + 3).changed).toBe(true);
    const tail = service.detail(id)!.history.slice(-4);
    expect(tail.map((entry) => entry.to)).toEqual(["rolled-back", "candidate", "approved", "active"]);
    expect(tail.map((entry) => entry.reason)).toEqual([
      "Rolled back by user", "Rollback retained active workflow", "Rollback reconciled", "Rollback reconciled",
    ]);
    expect(service.reconcile("assisted", BASE + 8 * DAY + 4)).toEqual({ signals: [], changed: false });
    expect(service.detail(id)!.history.slice(-4)).toEqual(tail);
  }, 15_000);

  it("heals a lifecycle-first restart exactly once without duplicate drafts or activation history", async () => {
    const first = await system();
    addEvidence(first.learner);
    first.service.reconcile("assisted", BASE + 10);
    const id = first.service.list()[0].id;
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const draft = lifecycle.loadLearnedProtocol(id);
    lifecycle.activateLearnedProtocol({
      slug: id,
      versionId: draft.versions[0].id,
      expectedActiveVersionId: null,
      reason: "Lifecycle committed before projection",
      timestamp: BASE + 11,
    });

    vi.resetModules();
    const second = await system();
    expect(second.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    expect(second.service.reconcile("assisted", BASE + 12).changed).toBe(true);
    const healed = (await import("../../protocols/learned-lifecycle.js")).loadLearnedProtocol(id);
    expect(healed.versions).toHaveLength(1);
    expect(healed.activationHistory).toHaveLength(1);
    expect(second.service.reconcile("assisted", BASE + 13)).toEqual({ signals: [], changed: false });
    expect(second.service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
  });

  it("uses an active lifecycle record over stale rejected candidate suppression", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;
    service.action(id, { action: "reject" }, BASE + 11);
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const draft = lifecycle.loadLearnedProtocol(id);
    lifecycle.activateLearnedProtocol({
      slug: id,
      versionId: draft.versions[0].id,
      expectedActiveVersionId: null,
      timestamp: BASE + 12,
    });

    expect(service.list()[0].state).toBe("active");
    expect(service.reconcile("assisted", BASE + 13).changed).toBe(true);
    expect(learner.getCandidates()[0].state).toBe("active");
  });

  it("projects lifecycle activation from the latest candidate state in one mutation", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;
    const project = learner.projectCandidateState.bind(learner);
    vi.spyOn(learner, "projectCandidateState").mockImplementationOnce((...args) => {
      learner.setCandidateState(id, "rejected", "Concurrent rejection", BASE + 11);
      return project(...args);
    });

    service.action(id, { action: "activate", expectedActiveVersionId: null }, BASE + 12);

    expect(learner.getCandidates()[0].state).toBe("active");
    expect(service.detail(id)!.history.slice(-4).map((entry) => entry.to)).toEqual([
      "rejected", "candidate", "approved", "active",
    ]);
  });

  it("fails a projection with no partial transition history when no legal path exists", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;
    learner.setCandidateState(id, "approved", "Approved", BASE + 11);
    const before = learner.getCandidates()[0];

    expect(() => learner.projectCandidateState(id, "candidate", "Invalid recovery", BASE + 12))
      .toThrow("Approved learned workflow requires activation recovery");
    learner.refresh();
    expect(learner.getCandidates()[0]).toEqual(before);
  });

  it("never activates a draft during repeated assisted reconciliation", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("assisted", BASE + 10);
    const id = service.list()[0].id;
    const lifecycle = await import("../../protocols/learned-lifecycle.js");

    expect(service.reconcile("assisted", BASE + 11)).toEqual({ signals: [], changed: false });
    expect(service.reconcile("assisted", BASE + 12)).toEqual({ signals: [], changed: false });
    const record = lifecycle.loadLearnedProtocol(id);
    expect(record).toMatchObject({ state: "draft", activeVersionId: null });
    expect(record.versions).toHaveLength(1);
    expect(record.activationHistory ?? []).toHaveLength(0);
  });
});
