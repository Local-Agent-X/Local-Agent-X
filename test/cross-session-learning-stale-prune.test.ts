import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  autoPrune,
  MAX_STALE_PER_TYPE,
} from "../src/cognition/cross-session-learning/persistence.js";
import type {
  ActionEntry,
  LearnedCandidate,
  SessionData,
} from "../src/cognition/cross-session-learning/types.js";
import {
  MS_PER_DAY,
  deriveCandidateId,
  normalizeLegacyEvidenceIdentities,
  PRUNE_AGE_DAYS,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../src/cognition/cross-session-learning/types.js";

// Regression for AM-3: recordAction lost its last caller in May, freezing the
// cross-session data file, yet signalsFor kept mining it every 5th message and
// injecting "Workflow 'tool -> tool' repeated ~4900 times" — a tokenized
// logging artifact — as live user behavior. Two root causes, both fixed:
//   1. autoPrune's keep-rule ("any type with >=3 entries survives forever")
//      could never shrink homogeneous data. Now stale entries of a recurring
//      type are capped at MAX_STALE_PER_TYPE (most recent first).
//   2. signalsFor had no recency gate. Now a pattern whose lastSeen is older
//      than the prune window is never emitted as a signal.

const NOW = Date.now();
const STALE_TS = NOW - (PRUNE_AGE_DAYS + 5) * MS_PER_DAY;
const FRESH_TS = NOW - 1 * MS_PER_DAY;

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
if (mode === "state" || mode === "revive") {
  const learner = CrossSessionLearner.getInstance();
  const candidate = learner.getCandidates()[0];
  const pattern = mode === "revive" ? learner.detectPatterns(3)[0] : undefined;
  writeFileSync(ready, "ready", "utf8");
  while (!existsSync(gate)) await new Promise((done) => setTimeout(done, 5));
  await new Promise((done) => setTimeout(done, Number(delay)));
  if (mode === "state") learner.setCandidateState(candidate.id, id, "concurrent", Number(requestedAt));
  else learner.captureCandidate(pattern, Number(requestedAt));
  process.exit(0);
}
while (gate && !existsSync(gate)) await new Promise((done) => setTimeout(done, 5));
const learner = CrossSessionLearner.getInstance();
if (mode === "record") {
  learner.recordAction("session-" + id, { type: "task", details: "action-" + id, timestamp: Number(id) + 1 });
  learner.recordOutcome({ opId: "unique-" + id, sessionId: "session-" + id, outcome: "clean", category: "coding", tools: ["read", "edit"], timestamp: Number(id) + 10 });
  learner.recordOutcome({ opId: "shared", sessionId: "shared-session", outcome: "clean", category: "coding", tools: ["read"], timestamp: Number(id) + 20 });
} else if (mode === "surface") {
  process.stdout.write(learner.nextLearningOpportunity(Date.now()) ? "surfaced" : "quiet");
}
process.exit(0);
`, "utf8");
  return worker;
}

function action(type: string, timestamp: number, i: number): ActionEntry {
  return { sessionId: "s1", type, details: `d${i}`, timestamp };
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

describe("autoPrune — bounded keep for stale recurring types", () => {
  it("prunes a frozen homogeneous file down to the per-type cap", () => {
    const actions: ActionEntry[] = [];
    for (let i = 0; i < 4900; i++) {
      actions.push(action("tool", STALE_TS + i, i));
    }
    const data: SessionData = { actions, candidates: [], lastPrune: 0 };

    const modified = autoPrune(data);

    // Pre-fix: all 4900 kept (type count >= 3), modified === false.
    expect(modified).toBe(true);
    expect(data.actions.length).toBe(MAX_STALE_PER_TYPE);
    // The allowance goes to the MOST RECENT stale entries, in original order.
    expect(data.actions[0].details).toBe(`d${4900 - MAX_STALE_PER_TYPE}`);
    expect(data.actions[data.actions.length - 1].details).toBe("d4899");
  });

  it("keeps all fresh entries and drops stale non-recurring ones", () => {
    const data: SessionData = {
      actions: [
        action("rare", STALE_TS, 0), // stale, count < 3 → dropped
        action("tool", STALE_TS + 1, 1),
        action("tool", STALE_TS + 2, 2),
        action("tool", STALE_TS + 3, 3),
        action("question", FRESH_TS, 4), // fresh → always kept
      ],
      candidates: [],
      lastPrune: 0,
    };

    autoPrune(data);

    expect(data.actions.map((a) => a.type)).toEqual([
      "tool",
      "tool",
      "tool",
      "question",
    ]);
  });

  it("still skips entirely when pruned within the last day", () => {
    const actions = Array.from({ length: 50 }, (_, i) =>
      action("tool", STALE_TS + i, i)
    );
    const data: SessionData = { actions, candidates: [], lastPrune: NOW };
    expect(autoPrune(data)).toBe(false);
    expect(data.actions.length).toBe(50);
  });
});

describe("signalsFor — stale patterns are never injected as signals", () => {
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

  function writeDataFile(actions: ActionEntry[], lastPrune: number): void {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "cross-session-data.json"),
      JSON.stringify({ actions, lastPrune }),
      "utf-8"
    );
  }

  it("returns no signal when every pattern comes from stale legacy data", async () => {
    // lastPrune = now so the constructor's autoPrune is a no-op, isolating
    // the recency gate: the raw stale data is exactly what signalsFor sees.
    const stale = Array.from({ length: 20 }, (_, i) =>
      action("tool", STALE_TS + i, i)
    );
    writeDataFile(stale, NOW);

    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();

    // The workflow pattern IS detectable — it just must not become a signal.
    expect(learner.detectPatterns(3).length).toBeGreaterThan(0);
    expect(learner.signalsFor()).toEqual([]);
  });

  it("still emits a signal for a genuinely recent recurring pattern", async () => {
    const fresh: ActionEntry[] = Array.from({ length: 3 }, (_, i) => ({
      ...TERMINAL_TELEMETRY_IDENTITY,
      opId: `fresh-${i}`,
      sessionId: `session-${i}`,
      type: "op_outcome",
      details: "coding:read -> edit",
      timestamp: FRESH_TS + i,
      outcome: "clean",
      category: "coding",
      tools: ["read", "edit"],
    }));
    writeDataFile(fresh, NOW);

    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const signals = CrossSessionLearner.getInstance().signalsFor();

    expect(signals.length).toBe(1);
    expect(signals[0].signal).toContain("ready for review");
  });

  it("persists only structural outcome evidence", async () => {
    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    CrossSessionLearner.getInstance().recordOutcome({
      opId: "op-7",
      sessionId: "session-7",
      outcome: "partial",
      category: "coding",
      tools: [" read ", "", "bash"],
      model: "model-x",
      timestamp: 1234,
    });

    const persisted = JSON.parse(
      readFileSync(join(tmpDir, "cross-session-data.json"), "utf-8")
    ) as SessionData;
    expect(persisted.actions).toEqual([{
      ...TERMINAL_TELEMETRY_IDENTITY,
      opId: "op-7",
      sessionId: "session-7",
      type: "op_outcome",
      details: "coding:read -> bash",
      timestamp: 1234,
      outcome: "partial",
      category: "coding",
      tools: ["read", "bash"],
      model: "model-x",
    }]);
    expect(JSON.stringify(persisted)).not.toContain("args");
    expect(JSON.stringify(persisted)).not.toContain("result");

    CrossSessionLearner.getInstance().recordOutcome({
      opId: "op-7",
      sessionId: "session-7",
      outcome: "clean",
      category: "coding",
      tools: ["read"],
      timestamp: 5678,
    });
    const replaced = JSON.parse(
      readFileSync(join(tmpDir, "cross-session-data.json"), "utf-8")
    ) as SessionData;
    expect(replaced.actions).toHaveLength(1);
    expect(replaced.actions[0]).toMatchObject({
      ...TERMINAL_TELEMETRY_IDENTITY,
      opId: "op-7",
      outcome: "clean",
      tools: ["read"],
      timestamp: 5678,
    });
  });

  it("normalizes only structurally unambiguous identity-less legacy records", async () => {
    writeDataFile([
      action("task", FRESH_TS, 1),
      {
        opId: "legacy-terminal",
        sessionId: "s2",
        type: "op_outcome",
        details: "coding:read",
        timestamp: FRESH_TS + 1,
        outcome: "clean",
        category: "coding",
        tools: ["read"],
      },
      { ...action("task", FRESH_TS + 2, 3), evidenceClass: "workflow-tactic" },
    ], NOW);

    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    CrossSessionLearner.getInstance();
    const persisted = JSON.parse(
      readFileSync(join(tmpDir, "cross-session-data.json"), "utf-8"),
    ) as SessionData;

    expect(persisted.actions[0]).toMatchObject(WORKFLOW_TACTIC_IDENTITY);
    expect(persisted.actions[1]).toMatchObject(TERMINAL_TELEMETRY_IDENTITY);
    expect(persisted.actions[2]).toMatchObject({ evidenceClass: "workflow-tactic" });
    expect(persisted.actions[2].authority).toBeUndefined();
  });

  it("normalizes structurally complete plain legacy candidates", () => {
    const candidate = legacyCandidate();
    const data: SessionData = { actions: [], candidates: [candidate], lastPrune: NOW };

    expect(normalizeLegacyEvidenceIdentities(data)).toBe(true);
    expect(candidate).toMatchObject(WORKFLOW_TACTIC_IDENTITY);
    expect(candidate.evidence).toMatchObject(TERMINAL_TELEMETRY_IDENTITY);
  });

  it("does not invoke terminal discriminator or tool accessors", () => {
    let reads = 0;
    const base = {
      sessionId: "s1",
      opId: "op-accessor",
      type: "op_outcome",
      details: "coding:read",
      timestamp: 1,
      outcome: "clean",
      category: "coding",
      tools: ["read"],
    };
    const accessorFields = ["type", "opId", "outcome", "category", "tools"].map((field) => {
      const record = { ...base };
      Object.defineProperty(record, field, {
        configurable: true,
        enumerable: true,
        get() { reads++; throw new Error(`${field} getter executed`); },
      });
      return record;
    });
    const accessorTools = ["read"];
    Object.defineProperty(accessorTools, "0", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("tool getter executed"); },
    });
    const terminal = {
      sessionId: "s2",
      opId: "op-tools",
      type: "op_outcome",
      details: "coding:read",
      timestamp: 2,
      outcome: "clean",
      category: "coding",
      tools: accessorTools,
    };
    const data = {
      actions: [...accessorFields, terminal] as unknown as ActionEntry[],
      candidates: [],
      lastPrune: NOW,
    };

    expect(() => normalizeLegacyEvidenceIdentities(data)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
    expect(reads).toBe(0);
    expect(accessorFields.every((record) => !Object.hasOwn(record, "authority"))).toBe(true);
    expect(Object.hasOwn(terminal, "authority")).toBe(false);
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
      lastPrune: NOW,
    };

    expect(() => normalizeLegacyEvidenceIdentities(data)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
    expect(reads).toBe(0);
    expect(data.candidates.every((candidate) => !Object.hasOwn(candidate, "authority"))).toBe(true);
  });

  it("rejects inherited identity without assigning through its descriptor", () => {
    let reads = 0;
    const prototype = {};
    Object.defineProperty(prototype, "authority", {
      get() { reads++; throw new Error("inherited getter executed"); },
    });
    Object.defineProperty(prototype, "evidenceClass", {
      value: "workflow-tactic",
      writable: false,
    });
    const inherited = Object.assign(Object.create(prototype) as object, {
      sessionId: "s1",
      type: "task",
      details: "read",
      timestamp: 1,
    }) as ActionEntry;
    const data: SessionData = { actions: [inherited], candidates: [], lastPrune: NOW };

    expect(() => normalizeLegacyEvidenceIdentities(data)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
    expect(reads).toBe(0);
    expect(Object.hasOwn(inherited, "authority")).toBe(false);
  });

  it("rejects non-enumerable legacy terminal discriminators", () => {
    const terminal = {
      sessionId: "s1",
      opId: "hidden-type",
      details: "coding:read",
      timestamp: 1,
      outcome: "clean",
      category: "coding",
      tools: ["read"],
    };
    Object.defineProperty(terminal, "type", { value: "op_outcome", enumerable: false });
    const data = {
      actions: [terminal] as unknown as ActionEntry[],
      candidates: [],
      lastPrune: NOW,
    };

    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
    expect(Object.hasOwn(terminal, "authority")).toBe(false);
  });

  it("treats revoked legacy actions and tool arrays as non-normalizable", () => {
    const actionRecord = Proxy.revocable(action("task", 1, 1), {});
    actionRecord.revoke();
    const tools = Proxy.revocable(["read"], {});
    const terminal = {
      sessionId: "s1",
      opId: "revoked-tools",
      type: "op_outcome",
      details: "coding:read",
      timestamp: 1,
      outcome: "clean",
      category: "coding",
      tools: tools.proxy,
    };
    tools.revoke();
    const data = {
      actions: [actionRecord.proxy, terminal] as unknown as ActionEntry[],
      candidates: [],
      lastPrune: NOW,
    };

    expect(() => normalizeLegacyEvidenceIdentities(data)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
    expect(Object.hasOwn(terminal, "authority")).toBe(false);
  });

  it("rejects hostile outer containers and array traversal without invoking them", () => {
    let reads = 0;
    const revoked = Proxy.revocable({ actions: [], candidates: [], lastPrune: NOW }, {});
    revoked.revoke();
    expect(() => normalizeLegacyEvidenceIdentities(revoked.proxy as SessionData)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(revoked.proxy as SessionData)).toBe(false);

    const accessorActions = [action("task", 1, 1)];
    Object.defineProperty(accessorActions, "0", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("array index getter executed"); },
    });
    const accessorData: SessionData = { actions: accessorActions, candidates: [], lastPrune: NOW };
    expect(normalizeLegacyEvidenceIdentities(accessorData)).toBe(false);

    const customIterator = [action("task", 1, 1)];
    Object.defineProperty(customIterator, Symbol.iterator, {
      configurable: true,
      get() { reads++; throw new Error("iterator getter executed"); },
    });
    expect(normalizeLegacyEvidenceIdentities({ actions: customIterator, candidates: [], lastPrune: NOW })).toBe(false);

    const outer = { candidates: [], lastPrune: NOW };
    Object.defineProperty(outer, "actions", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("outer getter executed"); },
    });
    expect(normalizeLegacyEvidenceIdentities(outer as SessionData)).toBe(false);
    expect(reads).toBe(0);
  });

  it("rejects oversized sparse arrays before traversing or allocating their length", () => {
    const huge: ActionEntry[] = [];
    huge.length = 1_000_000_000;
    const data: SessionData = { actions: huge, candidates: [], lastPrune: NOW };

    expect(() => normalizeLegacyEvidenceIdentities(data)).not.toThrow();
    expect(normalizeLegacyEvidenceIdentities(data)).toBe(false);
  });

  it("stamps new workflow actions with exact learning authority", async () => {
    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    CrossSessionLearner.getInstance().recordAction("session", {
      type: "task",
      details: "read then edit",
      timestamp: 99,
    });
    const persisted = JSON.parse(
      readFileSync(join(tmpDir, "cross-session-data.json"), "utf-8"),
    ) as SessionData;
    expect(persisted.actions[0]).toMatchObject(WORKFLOW_TACTIC_IDENTITY);
  });

  it("serializes real-process actions and outcomes without lost updates", async () => {
    const worker = writeLearningWorker(tmpDir);
    const gate = join(tmpDir, "start");
    const runs = Array.from({ length: 4 }, (_, index) =>
      runWorker(worker, ["record", String(index), gate], tmpDir));
    writeFileSync(gate, "go", "utf8");
    const results = await Promise.all(runs);

    expect(results).toEqual(results.map(() => ({ code: 0, stdout: "", stderr: "" })));
    const persisted = JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
    expect(persisted.actions.filter((entry) => entry.evidenceClass === "workflow-tactic")).toHaveLength(4);
    expect(persisted.actions.filter((entry) => entry.opId?.startsWith("unique-"))).toHaveLength(4);
    expect(persisted.actions.filter((entry) => entry.opId === "shared")).toHaveLength(1);
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
    const recovered = await runWorker(worker, ["record", "9", ""], tmpDir);
    expect(recovered).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(3_000);
    const persisted = JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
    expect(persisted.actions.some((entry) => entry.opId === "unique-9")).toBe(true);
  }, 10_000);

  it("preserves concurrent candidate transitions without stale resurrection", async () => {
    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();
    for (let index = 0; index < 3; index++) {
      learner.recordOutcome({
        opId: `seed-${index}`,
        sessionId: `seed-session-${index}`,
        outcome: "clean",
        category: "coding",
        tools: ["read", "edit"],
        timestamp: NOW + index,
      });
    }
    expect(learner.nextLearningOpportunity(NOW + 10)).not.toBeNull();

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

      const persisted = JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
      const candidate = persisted.candidates[0];
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
    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();
    for (let index = 0; index < 3; index++) {
      learner.recordOutcome({
        opId: `revive-${index}`,
        sessionId: `revive-session-${index}`,
        outcome: "clean",
        category: "coding",
        tools: ["read", "edit"],
        timestamp: NOW + index,
      });
    }
    const opportunity = learner.nextLearningOpportunity(NOW + 10);
    expect(opportunity).not.toBeNull();

    const worker = writeLearningWorker(tmpDir);
    const gate = join(tmpDir, "revive-start");
    const ready = `${gate}-ready`;
    const run = runWorker(worker, ["revive", "", gate, String(NOW + 10), "0", ready], tmpDir);
    await waitForFiles([ready]);
    learner.refresh();
    learner.setCandidateState(opportunity!.candidate.id, "rejected", "Concurrent rejection", NOW + 10);
    writeFileSync(gate, "go", "utf8");
    expect(await run).toEqual({ code: 0, stdout: "", stderr: "" });

    const persisted = JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
    const candidate = persisted.candidates[0];
    expect(candidate.state).toBe("rejected");
    expect(candidate.rejectionCooldownUntil).toBeGreaterThan(NOW + 10);
    expect(candidate.transitions.map((entry) => entry.to)).toEqual(["rejected"]);

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

    const afterStateRequest = JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
    expect(afterStateRequest.candidates[0].state).toBe("rejected");
    expect(afterStateRequest.candidates[0].transitions.map((entry) => entry.to))
      .toEqual(["rejected", "candidate", "rejected"]);
  }, 20_000);

  it("allows only one concurrent process to claim a surfacing cooldown", async () => {
    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();
    for (let index = 0; index < 3; index++) {
      learner.recordOutcome({
        opId: `surface-${index}`,
        sessionId: `surface-session-${index}`,
        outcome: "clean",
        category: "coding",
        tools: ["read", "edit"],
        timestamp: NOW + index,
      });
    }

    const worker = writeLearningWorker(tmpDir);
    const gate = join(tmpDir, "surface-start");
    const runs = ["a", "b"].map((id) => runWorker(worker, ["surface", id, gate], tmpDir));
    writeFileSync(gate, "go", "utf8");
    const results = await Promise.all(runs);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.map((result) => result.stdout).sort()).toEqual(["quiet", "surfaced"]);

    const persisted = JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
    expect(persisted.candidates).toHaveLength(1);
    expect(persisted.candidates[0].lastSurfacedOccurrences).toBe(3);
  }, 20_000);

  it("does not execute or publish a mutation when the mutex cannot be acquired", async () => {
    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();
    const lockPath = join(tmpDir, "cross-session-data.json.lock.sqlite");
    const blocker = new Database(lockPath);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      expect(() => learner.recordAction("blocked", {
        type: "forbidden", details: "must not escape the lock", timestamp: NOW,
      })).not.toThrow();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(learner.detectPatterns(1)).toEqual([]);
    const persisted = JSON.parse(readFileSync(join(tmpDir, "cross-session-data.json"), "utf8")) as SessionData;
    expect(persisted.actions).toEqual([]);
  }, 10_000);

  it("keeps the committed snapshot when the JSON write fails", async () => {
    const { CrossSessionLearner } = await import(
      "../src/cognition/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();
    learner.recordAction("kept", { type: "task", details: "committed", timestamp: NOW });
    const dataFile = join(tmpDir, "cross-session-data.json");
    rmSync(dataFile);
    mkdirSync(dataFile);

    expect(() => learner.recordAction("lost", {
      type: "task", details: "uncommitted", timestamp: NOW + 1,
    })).not.toThrow();
    const patterns = learner.detectPatterns(1);
    expect(patterns.some((pattern) => pattern.examples.includes("committed"))).toBe(true);
    expect(patterns.some((pattern) => pattern.examples.includes("uncommitted"))).toBe(false);
  });
});
