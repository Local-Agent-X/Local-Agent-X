/**
 * Constraint-extractor invariants:
 *
 *  1. FAIL-OPEN: an unconstrained message → EMPTY ledger via the phrase-gate
 *     path alone — the LLM confirmer is NEVER called. Blank input too.
 *  2. Gate hit + LLM confirm → the confirmed classes/obligations land in the
 *     ledger with the literal gate cues recorded in `phrases`.
 *  3. LLM null/throw → fail open: only the gate's STRONG tier (direct
 *     negation-verb adjacency, commit-when-done cue) survives; a weak cue
 *     ("don't commit", "just tell me") degrades to the empty ledger.
 *  4. The LLM is a precision filter: a confirmed-empty answer on a gate
 *     false-positive yields an empty ledger.
 *  5. extractConstraints never throws.
 *
 * All confirmers are injected — no test touches the network.
 */
import { describe, it, expect, vi } from "vitest";
import {
  extractConstraints,
  phraseGate,
  validateConfirmation,
  type ConfirmConstraintsFn,
} from "./extract.js";

const confirmNone: ConfirmConstraintsFn = async () => ({ prohibitions: [], obligations: [] });

describe("extractConstraints — phrase-gate path (no LLM)", () => {
  it("returns an empty ledger for an unconstrained message without calling the confirmer", async () => {
    const confirm = vi.fn(confirmNone);
    const ledger = await extractConstraints(
      "Fix the flaky retry logic in scheduler.ts and add a regression test.",
      confirm,
    );
    expect(ledger).toEqual({ prohibitions: [], obligations: [], phrases: [] });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns an empty ledger for blank input", async () => {
    const confirm = vi.fn(confirmNone);
    expect(await extractConstraints("", confirm)).toEqual({
      prohibitions: [],
      obligations: [],
      phrases: [],
    });
    expect(await extractConstraints("   \n", confirm)).toEqual({
      prohibitions: [],
      obligations: [],
      phrases: [],
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not gate on affirmative or past-tense mentions of the action verbs", () => {
    expect(phraseGate("Please edit parser.ts, run the tests, and push.").cues).toEqual([]);
    expect(phraseGate("I edited the config and pushed it yesterday.").cues).toEqual([]);
  });
});

describe("extractConstraints — confirmed constraints", () => {
  it("maps \"don't edit any code\" to a workspace-write prohibition", async () => {
    const confirm = vi.fn<ConfirmConstraintsFn>(async () => ({
      prohibitions: ["workspace-write"],
      obligations: [],
    }));
    const ledger = await extractConstraints(
      "Look at why the build is red but don't edit any code — just tell me what's wrong.",
      confirm,
    );
    expect(ledger.prohibitions).toContain("workspace-write");
    expect(ledger.obligations).toEqual([]);
    // the literal gate cues are recorded, and the confirmer saw them
    expect(ledger.phrases.some((p) => /don['’]?t edit/i.test(p))).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1].length).toBeGreaterThan(0);
  });

  it("maps \"commit when you're done\" to a commit-when-done obligation", async () => {
    const confirm = vi.fn<ConfirmConstraintsFn>(async () => ({
      prohibitions: [],
      obligations: [{ kind: "commit-when-done" }],
    }));
    const ledger = await extractConstraints(
      "Rename the helper across the repo and commit when you're done.",
      confirm,
    );
    expect(ledger.obligations).toEqual([{ kind: "commit-when-done" }]);
    expect(ledger.prohibitions).toEqual([]);
    expect(ledger.phrases.some((p) => /commit when/i.test(p))).toBe(true);
  });

  it("returns an empty ledger when the confirmer rejects a gate false-positive", async () => {
    // "Never … run" trips the gate, but it is not a constraint — the LLM
    // (here a double) says so, and nothing must land in the ledger.
    const ledger = await extractConstraints(
      "Never mind the linter warnings, run the tests and tell me what fails.",
      confirmNone,
    );
    expect(ledger).toEqual({ prohibitions: [], obligations: [], phrases: [] });
  });
});

describe("extractConstraints — LLM failure fails OPEN", () => {
  const confirmNull: ConfirmConstraintsFn = async () => null;

  it("returns an empty ledger on LLM null when the cue has no strong implication", async () => {
    // Gate hits ("just tell me", "don't … commit") but neither is in the
    // strong tier, so an unavailable LLM must not constrain anything.
    const ledger = await extractConstraints(
      "Just tell me what's wrong, and don't commit anything yet.",
      confirmNull,
    );
    expect(ledger).toEqual({ prohibitions: [], obligations: [], phrases: [] });
  });

  it("keeps only the strong deterministic tier on LLM null", async () => {
    const ledger = await extractConstraints("Don't edit anything under src/ yet.", confirmNull);
    expect(ledger.prohibitions).toEqual(["workspace-write"]);
    expect(ledger.obligations).toEqual([]);
    expect(ledger.phrases.length).toBeGreaterThan(0);
  });

  it("keeps the commit-when-done obligation on LLM null (unambiguous cue)", async () => {
    const ledger = await extractConstraints(
      "Tidy up the imports and commit when done.",
      confirmNull,
    );
    expect(ledger.obligations).toEqual([{ kind: "commit-when-done" }]);
  });

  it("never throws — a rejecting confirmer degrades like a null", async () => {
    const confirmThrow: ConfirmConstraintsFn = async () => {
      throw new Error("boom");
    };
    await expect(
      extractConstraints("Don't edit anything, I'll handle it myself.", confirmThrow),
    ).resolves.toMatchObject({ prohibitions: ["workspace-write"] });
    await expect(
      extractConstraints("Read-only please.", confirmThrow),
    ).resolves.toEqual({ prohibitions: [], obligations: [], phrases: [] });
  });
});

describe("phraseGate — strong tier stays narrow", () => {
  it("direct negation-verb adjacency is strong; distant or ambiguous cues are not", () => {
    expect(phraseGate("don't touch the config").strong.prohibitions).toEqual(["workspace-write"]);
    expect(phraseGate("don't open the browser").strong.prohibitions).toEqual(["egress"]);
    expect(phraseGate("don't run any commands").strong.prohibitions).toEqual(["shell"]);
    expect(phraseGate("don't read my secrets").strong.prohibitions).toEqual(["sensitive-read"]);
    // gated but NOT strong — class/scope is the LLM's call
    expect(phraseGate("don't commit anything").strong.prohibitions).toEqual([]);
    expect(phraseGate("don't run the tests").strong.prohibitions).toEqual([]);
    expect(phraseGate("the volume is read-only").strong.prohibitions).toEqual([]);
    // no negation at all → no gate, no strong
    expect(phraseGate("never mind, all good").strong.prohibitions).toEqual([]);
  });

  it("is reusable across calls (no /g lastIndex bleed)", () => {
    expect(phraseGate("don't touch main.ts").strong.prohibitions).toEqual(["workspace-write"]);
    expect(phraseGate("don't touch main.ts").strong.prohibitions).toEqual(["workspace-write"]);
  });
});

describe("validateConfirmation", () => {
  it("rejects non-object and shape-mismatched replies", () => {
    expect(validateConfirmation(null)).toBeNull();
    expect(validateConfirmation("yes")).toBeNull();
    expect(validateConfirmation({ prohibitions: "workspace-write" })).toBeNull();
    expect(validateConfirmation({ prohibitions: [], obligations: "commit" })).toBeNull();
  });

  it("drops unknown classes/obligations and dedupes, keeping the valid remainder", () => {
    expect(
      validateConfirmation({
        prohibitions: ["workspace-write", "workspace-write", "network", 3],
        obligations: ["commit-when-done", "deploy-when-done"],
      }),
    ).toEqual({
      prohibitions: ["workspace-write"],
      obligations: [{ kind: "commit-when-done" }],
    });
  });
});
