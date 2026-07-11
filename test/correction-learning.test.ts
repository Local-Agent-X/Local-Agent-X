/**
 * Pins the correction-detector's precision (AM-2): the pre-gate and the
 * "not X, Y" contrast rule used to fire on ordinary prose — includes("no")
 * matched "know"/"note"/"nothing" on nearly every message, and the contrast
 * regex recorded junk like "not sure, let us check the logs" at 0.75
 * confidence, polluting the store and driving spurious curate-nudge boosts.
 *
 * Invariants:
 *   1. Pre-gate matches whole words/phrases only — never substrings of
 *      unrelated words.
 *   2. Pre-gate still fires on genuine correction shapes (including
 *      "not X, Y" contrasts, which the old list only reached via the
 *      "no"-substring accident).
 *   3. The contrast rules only yield a correction when the negated fragment
 *      echoes something the agent actually said; hedges ("not sure, ...")
 *      and free-floating prose yield null.
 *   4. Genuine corrections are still detected with their original
 *      confidence.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let CorrectionLearner: typeof import("../src/cognition/correction-learning.js").CorrectionLearner;
let tmpRoot: string;
let prevDataDir: string | undefined;

beforeAll(async () => {
  // correction-learning.ts snaps its store path from LAX_DATA_DIR at module
  // load — point it at a tempdir BEFORE the (dynamic) import.
  prevDataDir = process.env.LAX_DATA_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "lax-correction-test-"));
  process.env.LAX_DATA_DIR = tmpRoot;
  ({ CorrectionLearner } = await import("../src/cognition/correction-learning.js"));
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("looksLikeCorrection pre-gate", () => {
  it("does not fire on substrings of ordinary words (know/note/nothing/now)", () => {
    expect(CorrectionLearner.looksLikeCorrection("I know, let me note that nothing changed for now")).toBe(false);
    expect(CorrectionLearner.looksLikeCorrection("Can you note the meeting for tomorrow? Nothing else.")).toBe(false);
    expect(CorrectionLearner.looksLikeCorrection("The notebook has known issues")).toBe(false);
  });

  it("still fires on genuine correction openers", () => {
    expect(CorrectionLearner.looksLikeCorrection("No, it's the other one")).toBe(true);
    expect(CorrectionLearner.looksLikeCorrection("nope, that file is elsewhere")).toBe(true);
    expect(CorrectionLearner.looksLikeCorrection("that's wrong")).toBe(true);
    expect(CorrectionLearner.looksLikeCorrection("I meant the staging server")).toBe(true);
    expect(CorrectionLearner.looksLikeCorrection("I already told you the port is 3000")).toBe(true);
  });

  it("fires on 'not X, Y' contrast shapes so the contrast rules stay reachable", () => {
    expect(CorrectionLearner.looksLikeCorrection("not staging, production")).toBe(true);
    expect(CorrectionLearner.looksLikeCorrection("it was not the parser but the tokenizer")).toBe(true);
  });
});

describe("detectCorrection contrast rules", () => {
  const learner = () => CorrectionLearner.getInstance();

  it("rejects hedge prose like 'not sure, let us check the logs'", () => {
    const result = learner().detectCorrection(
      "not sure, let us check the logs",
      "I think the parser failed on line 10.",
    );
    expect(result).toBeNull();
  });

  it("rejects 'not X, Y' when X refers to nothing the agent said", () => {
    const result = learner().detectCorrection(
      "not tonight, maybe tomorrow we can review it",
      "I finished refactoring the dispatcher module.",
    );
    expect(result).toBeNull();
  });

  it("accepts 'not X, Y' when X echoes the agent's message", () => {
    const result = learner().detectCorrection(
      "not staging, production",
      "I deployed it to the staging environment.",
    );
    expect(result).not.toBeNull();
    expect(result!.wrongInfo).toBe("staging");
    expect(result!.correctInfo).toBe("production");
    expect(result!.confidence).toBe(0.75);
  });

  it("accepts 'not X but Y' when X echoes the agent's message", () => {
    const result = learner().detectCorrection(
      "it was not the tokenizer but the parser",
      "The bug is in the tokenizer.",
    );
    expect(result).not.toBeNull();
    expect(result!.wrongInfo).toBe("the tokenizer");
    expect(result!.correctInfo).toBe("the parser");
  });

  it("still detects explicit-phrase corrections untouched by the contrast guard", () => {
    const result = learner().detectCorrection(
      "No, it's port 3000",
      "The server runs on port 8080.",
    );
    expect(result).not.toBeNull();
    expect(result!.correctInfo).toBe("port 3000");
    expect(result!.confidence).toBe(0.8);
  });
});

/**
 * The persist gate (AM-?): recordCorrectionMaybe() is the ONLY path that writes
 * durable memory, and its regex detector is paraphrase-blind. An LLM confirm now
 * vetoes false positives before the write. Fail-open on null/timeout/disabled —
 * losing a real correction is worse than an occasional false one.
 */
describe("recordCorrectionMaybe — LLM-confirmed persist", () => {
  function candidate(): import("../src/cognition/correction-learning.js").CorrectionEvent {
    const c = CorrectionLearner.getInstance().detectCorrection(
      "No, it's port 3000",
      "The server runs on port 8080.",
    );
    expect(c).not.toBeNull();
    return c!;
  }

  it("persists when the confirm returns true", async () => {
    const cl = CorrectionLearner.getInstance();
    const before = cl.getCorrectionHistory().length;
    const persisted = await cl.recordCorrectionMaybe(
      candidate(),
      "No, it's port 3000",
      "The server runs on port 8080.",
      async () => true,
    );
    expect(persisted).toBe(true);
    expect(cl.getCorrectionHistory().length).toBe(before + 1);
  });

  it("does NOT persist when the confirm returns false (the fix)", async () => {
    const cl = CorrectionLearner.getInstance();
    const before = cl.getCorrectionHistory().length;
    const persisted = await cl.recordCorrectionMaybe(
      candidate(),
      "No, it's port 3000",
      "The server runs on port 8080.",
      async () => false,
    );
    expect(persisted).toBe(false);
    expect(cl.getCorrectionHistory().length).toBe(before);
  });

  it("persists when the confirm returns null (fail-open parity regression)", async () => {
    const cl = CorrectionLearner.getInstance();
    const before = cl.getCorrectionHistory().length;
    const persisted = await cl.recordCorrectionMaybe(
      candidate(),
      "No, it's port 3000",
      "The server runs on port 8080.",
      async () => null,
    );
    expect(persisted).toBe(true);
    expect(cl.getCorrectionHistory().length).toBe(before + 1);
  });

  it("persists when the confirm THROWS (fail-open, treated as null)", async () => {
    const cl = CorrectionLearner.getInstance();
    const before = cl.getCorrectionHistory().length;
    const persisted = await cl.recordCorrectionMaybe(
      candidate(),
      "No, it's port 3000",
      "The server runs on port 8080.",
      async () => { throw new Error("provider down"); },
    );
    expect(persisted).toBe(true);
    expect(cl.getCorrectionHistory().length).toBe(before + 1);
  });

  it("a false-positive 'no …' shape with confirm=false stays out of durable memory", async () => {
    // The past bare-"no" over-fire: a genuine disagreement SHAPE the regex still
    // detects, but the user isn't overriding the agent — the LLM says NO, so it
    // must never become a persisted lesson.
    const cl = CorrectionLearner.getInstance();
    const fp = cl.detectCorrection(
      "No, keep going — that plan looks great",
      "I'll refactor the dispatcher next.",
    );
    // If the detector produced a candidate at all, a false confirm must suppress it.
    if (fp) {
      const before = cl.getCorrectionHistory().length;
      const persisted = await cl.recordCorrectionMaybe(
        fp,
        "No, keep going — that plan looks great",
        "I'll refactor the dispatcher next.",
        async () => false,
      );
      expect(persisted).toBe(false);
      expect(cl.getCorrectionHistory().length).toBe(before);
    }
  });

  it("the common path: pre-gate miss means no candidate, so no confirm and no persist", async () => {
    // A message the pre-gate rejects never reaches detectCorrection/persist —
    // the zero-LLM common path. We assert the gate rejects it; the caller
    // (signals-meta) only builds a candidate when detection returns non-null.
    expect(CorrectionLearner.looksLikeCorrection("Thanks, that worked perfectly")).toBe(false);
    const cl = CorrectionLearner.getInstance();
    const detected = cl.detectCorrection(
      "Thanks, that worked perfectly",
      "The server runs on port 8080.",
    );
    expect(detected).toBeNull();
  });
});
