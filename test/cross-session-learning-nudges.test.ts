import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.now();

describe("cross-session learning nudges", () => {
  const originalDataDir = process.env.LAX_DATA_DIR;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-learning-nudge-"));
    process.env.LAX_DATA_DIR = dataDir;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/config.js");
    if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function learnerWithEvidence() {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    for (let index = 0; index < 3; index++) {
      learner.recordOutcome({
        opId: `op-${index}`,
        sessionId: `session-${index}`,
        outcome: "clean",
        category: "coding",
        tools: ["read", "edit", "bash"],
        timestamp: BASE + index,
      });
    }
    return learner;
  }

  it("surfaces a strong assisted candidate once and deduplicates unchanged evidence", async () => {
    const learner = await learnerWithEvidence();
    const first = learner.signalsFor("assisted", BASE + 10);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ category: "learning-candidate", priority: 3 });
    expect(first[0].signal).toContain("ready for review");
    expect(learner.signalsFor("assisted", BASE + 11)).toEqual([]);
    expect(learner.signalsFor("assisted", BASE + 8 * DAY)).toEqual([]);
  });

  it("requires both stronger evidence and an expired cooldown before resurfacing", async () => {
    const learner = await learnerWithEvidence();
    expect(learner.signalsFor("assisted", BASE + 10)).toHaveLength(1);
    learner.recordOutcome({
      opId: "op-3",
      sessionId: "session-3",
      outcome: "clean",
      category: "coding",
      tools: ["read", "edit", "bash"],
      timestamp: BASE + 20,
    });

    expect(learner.signalsFor("assisted", BASE + DAY)).toEqual([]);
    expect(learner.signalsFor("assisted", BASE + 8 * DAY)).toHaveLength(1);
  });

  it("does not surface rejected candidates", async () => {
    const learner = await learnerWithEvidence();
    learner.signalsFor("assisted", BASE + 10);
    const candidate = learner.getCandidates()[0];
    learner.setCandidateState(candidate.id, "rejected", "Not useful", BASE + 20);
    learner.recordOutcome({
      opId: "op-3",
      sessionId: "session-3",
      outcome: "clean",
      category: "coding",
      tools: ["read", "edit", "bash"],
      timestamp: BASE + 30,
    });

    expect(learner.signalsFor("assisted", BASE + 8 * DAY)).toEqual([]);
  });

  it("keeps autonomous learning informational and low priority", async () => {
    const learner = await learnerWithEvidence();
    const signal = learner.signalsFor("autonomous", BASE + 10)[0];

    expect(signal).toMatchObject({ category: "learning-activity", priority: 1 });
    expect(signal.signal).toContain("Continue silently");
    expect(signal.signal.toLowerCase()).not.toContain("review");
    expect(learner.signalsFor("autonomous", BASE + 11)).toEqual([]);
  });

  it("reads the learning mode live in the orchestrator signal seam", async () => {
    const runtime = {
      learningMode: "autonomous" as "assisted" | "autonomous",
      workspace: join(dataDir, "workspace"),
    };
    const getRuntimeConfig = vi.fn(() => runtime);
    vi.doMock("../src/config.js", () => ({ getRuntimeConfig }));
    await learnerWithEvidence();
    const { metaSignals } = await import("../src/orchestrator/signals-meta.js");
    const signalModule = metaSignals.find((entry) => entry.id === "cross-session-learning")!;
    const out: import("../src/orchestrator/types.js").ModuleSignal[] = [];

    signalModule.run!({
      message: "continue",
      sessionId: "session-current",
      sessionMessages: [],
      timeOfDay: 12,
      dayOfWeek: 1,
    }, out);

    expect(getRuntimeConfig).toHaveBeenCalled();
    expect(out[0]).toMatchObject({ category: "learning-activity", priority: 1 });
  });
});
