import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type {
  LearnedCandidate,
  SessionData,
} from "../src/cognition/cross-session-learning/types.js";
import {
  deriveCandidateId,
  normalizeLegacyEvidenceIdentities,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../src/cognition/cross-session-learning/types.js";

// The cross-session learning store: what survives loading a legacy file,
// legacy identity normalization, and that mutations from separate processes
// serialize through the store's mutex without lost updates or stale
// resurrection.
//
// The file once also held a per-turn run log (`actions`) and its pruning. The
// log was retired with nothing reading it; loading a file drops its entries
// and keeps the key, empty, for older builds that receive the file by sync.

const NOW = Date.now();
const PROCEDURE = "vendor_portal_release";

function runWorker(script: string, args: string[], dataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, LAX_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolveChild({ code, stdout, stderr }));
  });
}

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for learning workers");
    await new Promise((done) => setTimeout(done, 10));
  }
}

function writeLearningWorker(dir: string): string {
  const worker = join(dir, "learning-worker.mjs");
  const learnerUrl = pathToFileURL(resolve("src/cognition/cross-session-learning/learner.ts")).href;
  writeFileSync(worker, `
import { existsSync, writeFileSync } from "node:fs";
import { CrossSessionLearner } from ${JSON.stringify(learnerUrl)};
const [mode, id, gate, requestedAt, delay, ready] = process.argv.slice(2);
const propose = (learner, sessionId, timestamp) => learner.recordReviewedProposal({
  name: ${JSON.stringify(PROCEDURE)}, description: "Release files through the vendor portal",
  sessionId, outcome: "verified", timestamp,
});
if (mode === "state" || mode === "revive") {
  const learner = CrossSessionLearner.getInstance();
  const candidate = learner.getCandidates()[0];
  writeFileSync(ready, "ready", "utf8");
  while (!existsSync(gate)) await new Promise((done) => setTimeout(done, 5));
  await new Promise((done) => setTimeout(done, Number(delay)));
  if (mode === "state") learner.setCandidateState(candidate.id, id, "concurrent", Number(requestedAt));
  else process.stdout.write(propose(learner, "stale-session", Number(requestedAt)).ok ? "revived" : "refused");
  process.exit(0);
}
while (gate && !existsSync(gate)) await new Promise((done) => setTimeout(done, 5));
const learner = CrossSessionLearner.getInstance();
if (mode === "propose") propose(learner, "session-" + id, Number(id) + 1);
process.exit(0);
`, "utf8");
  return worker;
}

function legacyCandidate(): LearnedCandidate {
  return {
    id: deriveCandidateId("workflow", "workflow", ["read -> edit"]),
    state: "candidate",
    confidence: 1,
    suggestion: {
      type: "mission",
      name: "workflow",
      description: "workflow",
      config: { patternType: "workflow", sequence: ["read -> edit"], occurrences: 3 },
    },
    evidence: {
      patternType: "workflow",
      description: "workflow",
      occurrences: 3,
      lastSeen: 3,
      examples: ["read -> edit"],
      outcomeStats: {
        clean: 3,
        partial: 0,
        aborted: 0,
        successRate: 1,
        weightedSuccessRate: 1,
        distinctSessions: 3,
      },
    },
    createdAt: 1,
    updatedAt: 1,
    transitions: [],
  };
}

describe("cross-session learning store", () => {
  const ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lax-csl-test-"));
    process.env.LAX_DATA_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_LAX_DATA_DIR === undefined) {
      delete process.env.LAX_DATA_DIR;
    } else {
      process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drops the retired run log on load and keeps the candidates", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "cross-session-data.json"), JSON.stringify({
      actions: [
        { sessionId: "s1", type: "task", details: "read", timestamp: NOW },
        { opId: "op-1", sessionId: "s2", type: "op_outcome", details: "coding:read", timestamp: NOW, outcome: "clean", category: "coding", tools: ["read"] },
      ],
      candidates: [legacyCandidate()],
      lastPrune: 0,
    }), "utf-8");

    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const [candidate] = CrossSessionLearner.getInstance().getCandidates();
    const persisted = JSON.parse(
      readFileSync(join(tmpDir, "cross-session-data.json"), "utf-8"),
    ) as Record<string, unknown>;

    expect(Object.keys(persisted).sort()).toEqual(["actions", "candidates"]);
    expect(persisted.actions).toEqual([]);
    expect(candidate).toMatchObject({ id: legacyCandidate().id, ...WORKFLOW_TACTIC_IDENTITY });
  });

  it("normalizes structurally complete plain legacy candidates", () => {
    const candidate = legacyCandidate();
    const data: SessionData = { actions: [], candidates: [candidate] };

    expect(normalizeLegacyEvidenceIdentities(data)).toBe(true);
    expect(candidate).toMatchObject(WORKFLOW_TACTIC_IDENTITY);
    expect(candidate.evidence).toMatchObject(TERMINAL_TELEMETRY_IDENTITY);
  });

  it("does not invoke nested candidate accessors or proxy traps", () => {
    let reads = 0;
    const configAccessor = legacyCandidate();
    Object.defineProperty(configAccessor.suggestion, "config", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("config getter executed"); },
    });
    const evidenceAccessor = legacyCandidate();
    Object.defineProperty(evidenceAccessor.evidence, "outcomeStats", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("outcome getter executed"); },
    });
    const proxyEvidence = legacyCandidate();
    proxyEvidence.evidence = new Proxy(proxyEvidence.evidence, {
      getOwnPropertyDescriptor() { reads++; throw new Error("proxy trap executed"); },
    });
    const data: SessionData = {
      actions: [],
      candidates: [configAccessor, evidenceAccessor, proxyEvidence],
    };

    expect(() => normalizeLegacyEvidenceIdentities(data)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
    expect(reads).toBe(0);
    expect(data.candidates.every((candidate) => !Object.hasOwn(candidate, "authority"))).toBe(true);
  });

  it("rejects hostile outer containers and array traversal without invoking them", () => {
    let reads = 0;
    const revoked = Proxy.revocable({ actions: [], candidates: [] }, {});
    revoked.revoke();
    expect(() => normalizeLegacyEvidenceIdentities(revoked.proxy as SessionData)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(revoked.proxy as SessionData)).toBe(false);

    const accessorCandidates = [legacyCandidate()];
    Object.defineProperty(accessorCandidates, "0", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("array index getter executed"); },
    });
    expect(normalizeLegacyEvidenceIdentities({ actions: [], candidates: accessorCandidates })).toBe(false);

    const customIterator = [legacyCandidate()];
    Object.defineProperty(customIterator, Symbol.iterator, {
      configurable: true,
      get() { reads++; throw new Error("iterator getter executed"); },
    });
    expect(normalizeLegacyEvidenceIdentities({ actions: [], candidates: customIterator })).toBe(false);

    const outer = { actions: [] };
    Object.defineProperty(outer, "candidates", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("outer getter executed"); },
    });
    expect(normalizeLegacyEvidenceIdentities(outer as unknown as SessionData)).toBe(false);
    expect(reads).toBe(0);
  });

  it("rejects oversized sparse arrays before traversing or allocating their length", () => {
    const huge: LearnedCandidate[] = [];
    huge.length = 1_000_000_000;
    const data: SessionData = { actions: [], candidates: huge };

    expect(() => normalizeLegacyEvidenceIdentities(data)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
  });

  async function learnerWithProcedure(timestamp = NOW) {
    const { CrossSessionLearner, LearningPersistenceUnavailableError } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();
    const propose = (name: string, sessionId: string, at: number) => learner.recordReviewedProposal({
      name, description: "Release files through the vendor portal", sessionId, outcome: "verified", timestamp: at,
    });
    const seeded = propose(PROCEDURE, "seed-session", timestamp);
    if (!seeded.ok) throw new Error(seeded.reason);
    return { learner, candidate: seeded.candidate, propose, LearningPersistenceUnavailableError };
  }

  function persistedData(): SessionData {
    return JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
  }

  it("serializes real-process proposals without lost updates", async () => {
    const worker = writeLearningWorker(tmpDir);
    const gate = join(tmpDir, "start");
    const runs = Array.from({ length: 4 }, (_, index) =>
      runWorker(worker, ["propose", String(index), gate], tmpDir));
    writeFileSync(gate, "go", "utf8");
    const results = await Promise.all(runs);

    expect(results).toEqual(results.map(() => ({ code: 0, stdout: "", stderr: "" })));
    const persisted = persistedData();
    expect(persisted.candidates).toHaveLength(1);
    expect(persisted.candidates[0].evidence.proposals?.map((entry) => entry.sessionId).sort())
      .toEqual(["session-0", "session-1", "session-2", "session-3"]);
    expect(persisted.candidates[0].evidence.occurrences).toBe(4);
  }, 20_000);

  it("releases a crashed process mutex without stale-lock recovery", async () => {
    const crashWorker = join(tmpDir, "crash-worker.mjs");
    const sqliteUrl = pathToFileURL(resolve("node_modules/better-sqlite3/lib/index.js")).href;
    writeFileSync(crashWorker, `
import Database from ${JSON.stringify(sqliteUrl)};
const db = new Database(process.argv[2]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked");
setTimeout(() => process.exit(23), 100);
`, "utf8");
    const lockPath = join(tmpDir, "cross-session-data.json.lock.sqlite");
    const crashed = await runWorker(crashWorker, [lockPath], tmpDir);
    expect(crashed).toMatchObject({ code: 23, stdout: "locked", stderr: "" });

    const worker = writeLearningWorker(tmpDir);
    const started = Date.now();
    const recovered = await runWorker(worker, ["propose", "9", ""], tmpDir);
    expect(recovered).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(persistedData().candidates[0].evidence.proposals?.some((entry) => entry.sessionId === "session-9")).toBe(true);
  }, 10_000);

  it("preserves concurrent candidate transitions without stale resurrection", async () => {
    const { learner } = await learnerWithProcedure(NOW);

    const worker = writeLearningWorker(tmpDir);
    const rounds = [
      { approvedAt: NOW + 30, approvedDelay: 0, archivedAt: NOW + 20, archivedDelay: 100 },
      { approvedAt: NOW + 50, approvedDelay: 100, archivedAt: NOW + 60, archivedDelay: 0 },
    ];
    for (const [index, round] of rounds.entries()) {
      const gate = join(tmpDir, `state-start-${index}`);
      const approvedReady = `${gate}-approved-ready`;
      const archivedReady = `${gate}-archived-ready`;
      const runs = [
        runWorker(worker, ["state", "approved", gate, String(round.approvedAt), String(round.approvedDelay), approvedReady], tmpDir),
        runWorker(worker, ["state", "archived", gate, String(round.archivedAt), String(round.archivedDelay), archivedReady], tmpDir),
      ];
      await waitForFiles([approvedReady, archivedReady]);
      writeFileSync(gate, "go", "utf8");
      const results = await Promise.all(runs);
      expect(results.filter((result) => result.code === 0).length).toBeGreaterThanOrEqual(1);

      const candidate = persistedData().candidates[0];
      expect(candidate.state).toBe("archived");
      expect(candidate.transitions.at(-1)?.to).toBe("archived");
      expect(candidate.transitions[0]?.from).toBe("candidate");
      expect(candidate.transitions.every((entry, transitionIndex) =>
        transitionIndex === 0 || entry.timestamp >= candidate.transitions[transitionIndex - 1].timestamp
      )).toBe(true);
      if (index < rounds.length - 1) {
        learner.refresh();
        learner.setCandidateState(candidate.id, "candidate", "Prepare next contention", NOW + 40);
      }
    }
  }, 30_000);

  it("does not revive an equal-time rejection from a stale process snapshot", async () => {
    const { learner, candidate: seeded } = await learnerWithProcedure(NOW);

    const worker = writeLearningWorker(tmpDir);
    const gate = join(tmpDir, "revive-start");
    const ready = `${gate}-ready`;
    const run = runWorker(worker, ["revive", "", gate, String(NOW + 10), "0", ready], tmpDir);
    await waitForFiles([ready]);
    learner.refresh();
    learner.setCandidateState(seeded.id, "rejected", "Concurrent rejection", NOW + 10);
    writeFileSync(gate, "go", "utf8");
    expect(await run).toEqual({ code: 0, stdout: "refused", stderr: "" });

    const candidate = persistedData().candidates[0];
    expect(candidate.state).toBe("rejected");
    expect(candidate.rejectionCooldownUntil).toBeGreaterThan(NOW + 10);
    expect(candidate.transitions.map((entry) => entry.to)).toEqual(["rejected"]);
    expect(candidate.evidence.proposals?.map((entry) => entry.sessionId)).toEqual(["seed-session"]);

    learner.refresh();
    learner.setCandidateState(candidate.id, "candidate", "Prepare explicit stale request", NOW + 20);
    const stateGate = join(tmpDir, "stale-state-start");
    const stateReady = `${stateGate}-ready`;
    const stateRun = runWorker(worker, ["state", "candidate", stateGate, String(NOW + 20), "0", stateReady], tmpDir);
    await waitForFiles([stateReady]);
    learner.refresh();
    learner.setCandidateState(candidate.id, "rejected", "Concurrent rejection", NOW + 20);
    writeFileSync(stateGate, "go", "utf8");
    expect((await stateRun).code).not.toBe(0);

    const afterStateRequest = persistedData();
    expect(afterStateRequest.candidates[0].state).toBe("rejected");
    expect(afterStateRequest.candidates[0].transitions.map((entry) => entry.to))
      .toEqual(["rejected", "candidate", "rejected"]);
  }, 20_000);

  it("does not execute or publish a mutation when the mutex cannot be acquired", async () => {
    const { CrossSessionLearner, LearningPersistenceUnavailableError } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();
    const lockPath = join(tmpDir, "cross-session-data.json.lock.sqlite");
    const blocker = new Database(lockPath);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      expect(() => learner.recordReviewedProposal({
        name: PROCEDURE, description: "must not escape the lock", sessionId: "blocked",
        outcome: "verified", timestamp: NOW,
      })).toThrow(LearningPersistenceUnavailableError);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(learner.getCandidates()).toEqual([]);
    expect(persistedData().candidates).toEqual([]);
  }, 10_000);

  it("keeps the committed snapshot when the JSON write fails", async () => {
    const { learner, candidate: kept, propose, LearningPersistenceUnavailableError } = await learnerWithProcedure(NOW);
    const dataFile = join(tmpDir, "cross-session-data.json");
    rmSync(dataFile);
    mkdirSync(dataFile);

    expect(() => propose("vendor_portal_refund", "lost-session", NOW + 1)).toThrow(LearningPersistenceUnavailableError);
    expect(learner.getCandidates()).toEqual([kept]);
  });
});
