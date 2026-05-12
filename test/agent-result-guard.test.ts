/**
 * Pins the clarification-request guard's behavior — the heuristic that
 * stops agents from quietly persisting "done" runs when their actual
 * output was "please send the topic, I don't know what you want."
 *
 * Spec for the guard:
 *   1. Triggers on short results that contain known clarification
 *      phrases. Both conditions must hold.
 *   2. Does NOT trigger on long completed reports that happen to
 *      mention clarification language in narrative.
 *   3. Does NOT trigger on short outputs without clarification phrasing
 *      (legitimate brief answers).
 *   4. Returns the matched phrase so the stored error record can
 *      tell the user / next maintainer exactly what tripped it.
 */

import { describe, it, expect } from "vitest";
import { looksLikeClarificationRequest } from "../src/agents/result-guard.js";

describe("looksLikeClarificationRequest — bail detection", () => {
  it("trips on the exact gravity-failure shape", () => {
    // Verbatim from the failed Deep Researcher run that prompted the
    // guard. If we ever regress on this case the guard is broken.
    const result = "Understood. I stopped the failing path and switched approaches.\n\nInstead of repeating the same search/tool pattern, I moved to direct authoritative sources I already knew, including:\n\n- Einstein Online / Max Planck Institute material on gravity as spacetime curvature\n- Nobel Prize / LIGO material on gravitational-wave evidence\n- Stanford Gravity Probe B mission results\n\nThose direct fetches succeeded and returned usable source material.\n\nHowever, I don't currently have the actual research question/topic in this chat thread. Please send the topic or goal you want researched, and I'll continue from the better approach rather than repeating the failed one.";
    const verdict = looksLikeClarificationRequest(result);
    expect(verdict.isClarificationRequest).toBe(true);
    expect(verdict.matchedPhrase).toBeTruthy();
  });

  it("trips on common 'could you clarify' phrasings", () => {
    const cases = [
      "I'm not sure what you want. Could you clarify the scope?",
      "Can you specify which platform you're targeting?",
      "What would you like me to focus on?",
      "Please send the task you want researched.",
      "Please provide the topic.",
      "Which question would you like answered?",
    ];
    for (const r of cases) {
      const verdict = looksLikeClarificationRequest(r);
      expect(verdict.isClarificationRequest, `should trip on: "${r}"`).toBe(true);
    }
  });

  it("does NOT trip on long completed reports that mention clarification language", () => {
    // A real report can reference clarification in narrative without
    // BEING a clarification request. Length is the discriminator.
    const longReport = "# Market Brief: Q3 Pricing Analysis\n\n" + "Detailed competitor analysis follows.\n".repeat(50) +
      "\n\nOne caveat: the data team could clarify the cohort definitions in a follow-up — but the trend is clear regardless.";
    expect(longReport.length).toBeGreaterThan(600);
    const verdict = looksLikeClarificationRequest(longReport);
    expect(verdict.isClarificationRequest).toBe(false);
  });

  it("does NOT trip on short legitimate answers without clarification phrasing", () => {
    const cases = [
      "Done. Wrote the file to workspace/notes.md.",
      "Yes — confirmed via the build log at line 247.",
      "Found 3 references to the deprecated API. Removed all of them in src/legacy/.",
    ];
    for (const r of cases) {
      const verdict = looksLikeClarificationRequest(r);
      expect(verdict.isClarificationRequest, `should NOT trip on: "${r}"`).toBe(false);
    }
  });

  it("handles edge inputs without throwing", () => {
    expect(looksLikeClarificationRequest("").isClarificationRequest).toBe(false);
    // @ts-expect-error testing runtime robustness
    expect(looksLikeClarificationRequest(null).isClarificationRequest).toBe(false);
    // @ts-expect-error testing runtime robustness
    expect(looksLikeClarificationRequest(undefined).isClarificationRequest).toBe(false);
  });
});
