import { describe, it, expect, vi } from "vitest";
import { validateMissionOutput, validateMissionOutputConfirmed } from "./output-validation.js";

const PROMPT = "Scan supplement industry trends and produce a markdown report on creatine pricing";

const GOOD_REPORT = [
  "# Creatine Pricing Report",
  "",
  "## Overview",
  "Creatine monohydrate wholesale pricing held steady this week across major suppliers.",
  "",
  "- Supplier A: $12.40/kg, down 2% from last week.",
  "- Supplier B: $12.90/kg, flat.",
  "- Supplier C: $13.10/kg, up 1% on freight costs.",
  "",
  "## Trends",
  "Retail creatine pricing continues to compress as house brands expand. Bulk pricing",
  "remains the primary lever for smaller stores. Demand indicators stayed positive.",
  "",
  "## Recommendation",
  "Hold current supplement stock levels; revisit pricing after the next supplier update.",
].join("\n");

// Delivers the mission but opens with an apology-shaped caveat that trips the
// refusal regex, and uses synonyms ("cost per unit") for the prompt keywords.
const CAVEAT_REPORT =
  "I'm sorry, I can't access one distributor portal, but here is the full analysis.\n\n" +
  GOOD_REPORT;

describe("validateMissionOutput (sync regex gate)", () => {
  it("accepts a clean structured report", () => {
    const v = validateMissionOutput(PROMPT, GOOD_REPORT, "end_turn");
    expect(v.valid).toBe(true);
  });

  it("rejects a refusal-opening output", () => {
    const v = validateMissionOutput(PROMPT, CAVEAT_REPORT, "end_turn");
    expect(v.valid).toBe(false);
    expect(v.details?.refusal?.refused).toBe(true);
  });

  it("rejects too-short output", () => {
    const v = validateMissionOutput(PROMPT, "Done.", "end_turn");
    expect(v.valid).toBe(false);
  });
});

describe("validateMissionOutputConfirmed (LLM second opinion)", () => {
  it("does not consult the LLM when the regex gate passes", async () => {
    const confirm = vi.fn();
    const v = await validateMissionOutputConfirmed(PROMPT, GOOD_REPORT, "end_turn", confirm);
    expect(v.valid).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("overrides a semantic rejection when the LLM says the output delivers", async () => {
    const confirm = vi.fn(async () => false);
    const v = await validateMissionOutputConfirmed(PROMPT, CAVEAT_REPORT, "end_turn", confirm);
    expect(v.valid).toBe(true);
    expect(v.contentValid).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("keeps the rejection when the LLM agrees it is a refusal", async () => {
    const confirm = vi.fn(async () => true);
    const v = await validateMissionOutputConfirmed(PROMPT, CAVEAT_REPORT, "end_turn", confirm);
    expect(v.valid).toBe(false);
  });

  it("keeps the rejection on null verdict and confirmer errors (fail-open)", async () => {
    for (const confirm of [async () => null, async () => { throw new Error("down"); }]) {
      const v = await validateMissionOutputConfirmed(PROMPT, CAVEAT_REPORT, "end_turn", confirm as never);
      expect(v.valid).toBe(false);
    }
  });

  it("never second-guesses structural rejections", async () => {
    const confirm = vi.fn();
    const v = await validateMissionOutputConfirmed(PROMPT, "Done.", "end_turn", confirm);
    expect(v.valid).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("LLM content override still respects a bad stopReason", async () => {
    const confirm = vi.fn(async () => false);
    const v = await validateMissionOutputConfirmed(PROMPT, CAVEAT_REPORT, "error", confirm);
    expect(v.valid).toBe(false);
    expect(v.contentValid).toBe(true); // salvage path in cron-runner still ships it
  });
});
