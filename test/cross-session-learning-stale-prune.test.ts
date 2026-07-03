import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoPrune,
  MAX_STALE_PER_TYPE,
} from "../src/cross-session-learning/persistence.js";
import type {
  ActionEntry,
  SessionData,
} from "../src/cross-session-learning/types.js";
import {
  MS_PER_DAY,
  PRUNE_AGE_DAYS,
} from "../src/cross-session-learning/types.js";

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

describe("autoPrune — bounded keep for stale recurring types", () => {
  it("prunes a frozen homogeneous file down to the per-type cap", () => {
    const actions: ActionEntry[] = [];
    for (let i = 0; i < 4900; i++) {
      actions.push(action("tool", STALE_TS + i, i));
    }
    const data: SessionData = { actions, lastPrune: 0 };

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
    const data: SessionData = { actions, lastPrune: NOW };
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
      "../src/cross-session-learning/learner.js"
    );
    const learner = CrossSessionLearner.getInstance();

    // The workflow pattern IS detectable — it just must not become a signal.
    expect(learner.detectPatterns(3).length).toBeGreaterThan(0);
    expect(learner.signalsFor()).toEqual([]);
  });

  it("still emits a signal for a genuinely recent recurring pattern", async () => {
    const fresh = Array.from({ length: 20 }, (_, i) =>
      action("tool", FRESH_TS + i, i)
    );
    writeDataFile(fresh, NOW);

    const { CrossSessionLearner } = await import(
      "../src/cross-session-learning/learner.js"
    );
    const signals = CrossSessionLearner.getInstance().signalsFor();

    expect(signals.length).toBe(1);
    expect(signals[0].signal).toContain("Recurring pattern");
  });
});
