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

let CorrectionLearner: typeof import("../src/correction-learning.js").CorrectionLearner;
let tmpRoot: string;
let prevDataDir: string | undefined;

beforeAll(async () => {
  // correction-learning.ts snaps its store path from LAX_DATA_DIR at module
  // load — point it at a tempdir BEFORE the (dynamic) import.
  prevDataDir = process.env.LAX_DATA_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "lax-correction-test-"));
  process.env.LAX_DATA_DIR = tmpRoot;
  ({ CorrectionLearner } = await import("../src/correction-learning.js"));
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
