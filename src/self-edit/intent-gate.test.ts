/**
 * intent-gate — schema-validated match/mismatch/unsure verdict.
 *
 * All model calls are injected via the classifySchema `_llm` seam; no test
 * touches the network. Locks in: the strict verdict enum (off-vocabulary →
 * single retry → null → caller's fallback), the tolerant reason field, and
 * the deterministic affirmative-go-ahead backstop.
 */
import { describe, it, expect, vi } from "vitest";
import { checkSelfEditIntent, isAffirmativeGoAhead } from "./intent-gate.js";

type Llm = (systemPrompt: string, userPrompt: string) => Promise<string | null>;

const TASK = "patch the chat renderer so the caret clears on turn end";
const USER_MSG = "fix the chat freeze, the caret never goes away";
const ASSISTANT_MSG = "I can patch the renderer if you want.";

function check(llm: Llm) {
  return checkSelfEditIntent(TASK, USER_MSG, ASSISTANT_MSG, llm);
}

describe("checkSelfEditIntent — schema-validated path (injected _llm)", () => {
  it("accepts each valid verdict", async () => {
    for (const verdict of ["match", "mismatch", "unsure"] as const) {
      const llm = vi.fn<Llm>(async () => `{"verdict": "${verdict}", "reason": "because"}`);
      await expect(check(llm)).resolves.toEqual({ verdict, reason: "because" });
      expect(llm).toHaveBeenCalledTimes(1);
    }
  });

  it("an off-vocabulary verdict is rejected — single retry with error feedback, then null", async () => {
    const llm = vi.fn<Llm>(async () => `{"verdict": "maybe", "reason": "hmm"}`);
    await expect(check(llm)).resolves.toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][1]).toContain("Your previous reply was invalid:");
  });

  it("self-corrects on retry", async () => {
    const llm = vi.fn<Llm>()
      .mockResolvedValueOnce(`the verdict is match`)
      .mockResolvedValueOnce(`{"verdict": "match", "reason": "user reported a bug"}`);
    await expect(check(llm)).resolves.toEqual({ verdict: "match", reason: "user reported a bug" });
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("tolerates a missing or non-string reason (verdict is the load-bearing field)", async () => {
    const missing = vi.fn<Llm>(async () => `{"verdict": "mismatch"}`);
    await expect(check(missing)).resolves.toEqual({ verdict: "mismatch", reason: "" });
    const numeric = vi.fn<Llm>(async () => `{"verdict": "unsure", "reason": 42}`);
    await expect(check(numeric)).resolves.toEqual({ verdict: "unsure", reason: "42" });
  });

  it("caps a runaway reason at 200 chars", async () => {
    const llm = vi.fn<Llm>(async () => `{"verdict": "match", "reason": "${"r".repeat(500)}"}`);
    const result = await check(llm);
    expect(result?.reason).toHaveLength(200);
  });

  it("LLM unavailable (null) → null without a retry (caller fails open)", async () => {
    const llm = vi.fn<Llm>(async () => null);
    await expect(check(llm)).resolves.toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe("isAffirmativeGoAhead — deterministic backstop", () => {
  it("matches explicit go-aheads anchored at the start", () => {
    expect(isAffirmativeGoAhead("yes")).toBe(true);
    expect(isAffirmativeGoAhead("  go ahead, ship it")).toBe(true);
    expect(isAffirmativeGoAhead("fix it please")).toBe(true);
  });

  it("does not match observations or questions", () => {
    expect(isAffirmativeGoAhead("i dont see the committed change")).toBe(false);
    expect(isAffirmativeGoAhead("did that actually work?")).toBe(false);
  });
});
