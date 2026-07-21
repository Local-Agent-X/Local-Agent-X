import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
