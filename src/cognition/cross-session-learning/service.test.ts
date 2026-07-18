import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("drafts a stronger refinement in assisted mode without activating it", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const firstVersion = service.list()[0].activeVersionId;

    addEvidence(learner, 6);
    service.reconcile("assisted", BASE + 8 * DAY);

    expect(service.list()[0]).toMatchObject({ activeVersionId: firstVersion, versionCount: 2, state: "active" });
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
    const lifecyclePath = join(workspace, "protocols", "imported", id, "learned.json");
    const before = readFileSync(lifecyclePath, "utf8");
    writeFileSync(join(workspace, "protocols", "imported", id, "SKILL.md"), "tampered\n");

    expect(() => service.reconcile("assisted", BASE + 20)).toThrow(/materialization mismatch/);
    expect(readFileSync(lifecyclePath, "utf8")).toBe(before);
  });

  it("uses the active version creation boundary for legacy records without activation history", async () => {
    const { learner, service } = await system();
    addEvidence(learner);
    service.reconcile("autonomous", BASE + 10);
    const id = service.list()[0].id;
    const active = service.list()[0].activeVersionId!;
    const lifecyclePath = join(workspace, "protocols", "imported", id, "learned.json");
    const legacy = JSON.parse(readFileSync(lifecyclePath, "utf8")) as Record<string, unknown>;
    delete legacy.activationHistory;
    writeFileSync(lifecyclePath, JSON.stringify(legacy, null, 2));
    const afterCreation = Date.now() + 1_000;
    await commitOutcomes(id, active, ["aborted", "clean", "aborted"], afterCreation);

    service.reconcile("assisted", afterCreation + 10);
    expect(service.list()[0].state).toBe("archived");
  });

  it("resumes approved activation without a fake rejection and heals filesystem-first recovery", async () => {
    const first = await system();
    addEvidence(first.learner);
    first.service.reconcile("assisted", BASE + 10);
    const id = first.service.list()[0].id;
    first.learner.setCandidateState(id, "approved", "Interrupted activation", BASE + 11);
    expect(first.service.reconcile("assisted", BASE + 12).changed).toBe(true);
    expect(first.service.list()[0].state).toBe("active");
    expect(first.service.detail(id)!.history.some((entry) => entry.to === "rejected")).toBe(false);
    first.service.action(id, { action: "archive", expectedActiveVersionId: first.service.list()[0].activeVersionId }, BASE + 13);

    vi.resetModules();
    const second = await system();
    const lifecycle = await import("../../protocols/learned-lifecycle.js");
    const record = lifecycle.loadLearnedProtocol(id);
    lifecycle.activateLearnedProtocol({
      slug: id,
      versionId: record.versions[0].id,
      expectedActiveVersionId: record.activeVersionId,
    });
    expect(second.learner.getCandidates()[0].state).toBe("archived");

    const healed = second.service.reconcile("assisted", BASE + 14);
    expect(healed.changed).toBe(true);
    expect(second.service.list()[0].state).toBe("active");
    expect(second.service.detail(id)!.history.map((entry) => entry.to)).toEqual(expect.arrayContaining(["candidate", "approved", "active"]));
  });
});
