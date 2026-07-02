/**
 * Tests for refuteSelfEditMerge — the verify-by-refutation gate that scrutinizes
 * a self_edit merge diff before it lands.
 *
 * We mock verifyByRefutation (the tally lives in classifiers/, tested there) and
 * assert this wrapper's policy: empty diff short-circuits with NO LLM call, an
 * affirmative majority "refuted" verdict HOLDS the merge, and both "holds" and
 * "inconclusive" PROCEED (fail-open — a self_edit must never be blocked just
 * because the background model is down).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RefutationVerdict } from "../src/classifiers/verify-by-refutation.js";

const verifyByRefutation = vi.fn();
vi.mock("../src/classifiers/verify-by-refutation.js", () => ({
  verifyByRefutation: (...args: unknown[]) => verifyByRefutation(...args),
}));

import { refuteSelfEditMerge } from "../src/self-edit/refute-merge.js";

beforeEach(() => {
  verifyByRefutation.mockReset();
});

describe("refuteSelfEditMerge", () => {
  it("(a) empty diff → hold:false with NO LLM call", async () => {
    const result = await refuteSelfEditMerge({ diff: "   \n  ", requestedTask: "tidy up" });
    expect(result.hold).toBe(false);
    expect(result.verdict.verdict).toBe("inconclusive");
    expect(result.reason).toBe("no diff to scrutinize");
    expect(verifyByRefutation).not.toHaveBeenCalled();
  });

  it("(b) verdict 'refuted' → hold:true", async () => {
    const verdict: RefutationVerdict = {
      verdict: "refuted", refutedCount: 2, holdsCount: 1, nullCount: 0, voters: 3,
    };
    verifyByRefutation.mockResolvedValue(verdict);

    const result = await refuteSelfEditMerge({
      diff: "diff --git a/src/x.ts b/src/x.ts\n+const x = 1;",
      requestedTask: "add x",
    });
    expect(result.hold).toBe(true);
    expect(result.verdict).toBe(verdict);
    expect(result.reason).toBe("2/3 skeptics refuted");
    expect(verifyByRefutation).toHaveBeenCalledTimes(1);
  });

  it("(c) verdict 'holds' → hold:false (survived scrutiny)", async () => {
    verifyByRefutation.mockResolvedValue({
      verdict: "holds", refutedCount: 0, holdsCount: 3, nullCount: 0, voters: 3,
    } satisfies RefutationVerdict);

    const result = await refuteSelfEditMerge({
      diff: "diff --git a/src/y.ts b/src/y.ts\n+const y = 2;",
      requestedTask: "add y",
    });
    expect(result.hold).toBe(false);
    expect(verifyByRefutation).toHaveBeenCalledTimes(1);
  });

  it("(d) verdict 'inconclusive' → hold:false (fail-open, e.g. model down)", async () => {
    verifyByRefutation.mockResolvedValue({
      verdict: "inconclusive", refutedCount: 0, holdsCount: 0, nullCount: 3, voters: 3,
    } satisfies RefutationVerdict);

    const result = await refuteSelfEditMerge({
      diff: "diff --git a/src/z.ts b/src/z.ts\n+const z = 3;",
      requestedTask: "add z",
    });
    expect(result.hold).toBe(false);
    expect(verifyByRefutation).toHaveBeenCalledTimes(1);
  });

  it("passes the self-edit lenses, category, and env-disable var through", async () => {
    verifyByRefutation.mockResolvedValue({
      verdict: "holds", refutedCount: 0, holdsCount: 3, nullCount: 0, voters: 3,
    } satisfies RefutationVerdict);

    await refuteSelfEditMerge({ diff: "some diff", requestedTask: "do a thing" });

    const callArg = verifyByRefutation.mock.calls[0][0] as {
      category: string; envDisableVar: string; lenses: string[]; userPrompt: string;
    };
    expect(callArg.category).toBe("self-edit-refute");
    expect(callArg.envDisableVar).toBe("LAX_SELF_EDIT_REFUTE");
    expect(callArg.lenses).toHaveLength(3);
    expect(callArg.userPrompt).toContain("do a thing");
    expect(callArg.userPrompt).toContain("some diff");
    // AB-11: the scope yardstick is the REQUEST, framed as the ask — never the
    // surgeon's own account. The old "Stated intent" anchor let a scope-creeping
    // edit grade itself.
    expect(callArg.userPrompt).toContain("ASKED to do");
    expect(callArg.userPrompt).not.toContain("Stated intent of this self_edit");
  });
});
