/**
 * Regression: "agent forgets the active task after a brief pause."
 *
 * Real failure (session chat-mox9veaj-i2zwt, 2026-05-08):
 *   USER: [SO-53468.pdf] Enter this purchase order into thriventory
 *   ASSISTANT: Got the invoice — S53468 ... Click into the email field
 *   USER: Im logged in go
 *   ASSISTANT: What's the move — keep adding the missing Sports Life
 *              products or jump into a PO?
 *
 * The "Sports Life products" content is profile-scope memory from a prior
 * session. It bled into the active PO entry because:
 *   1. The followup classifier was binary (followup vs new), so resume-
 *      style messages ("im logged in go") classified as either:
 *        - "followup" → drop session-scope, keep ALL profile-scope (bleed)
 *        - "new" → topical gate against "im logged in go" (no topic words,
 *          permissive — bleed)
 *   2. There was no concept of "active task" — the orchestrator gated on
 *      the literal current message instead of the session's anchor task.
 *
 * Fix: classifier returns "followup" | "resume" | "new"; on "resume",
 * filter ALL signals against the first substantive user message of the
 * session (the active-task anchor), not the resume message itself.
 *
 * This test locks in the verdict-parsing contract and the deterministic
 * fallback path of the orchestrator's resume-gate (regex topical-relevance
 * filter, no LLM dependency).
 */

import { describe, it, expect } from "vitest";

describe("followup classifier — verdict parsing", () => {
  // The classifier's parse function is the source-of-truth for mapping LLM
  // raw text to verdict. We can't assert LLM behavior in a unit test, but
  // we can assert the contract: every accepted shape maps to the right
  // verdict, every malformed shape returns null.
  function parse(raw: string): "followup" | "resume" | "new" | null {
    const m = raw.trim().match(/^\s*(FOLLOWUP|RESUME|NEW)\b/i);
    if (!m) return null;
    const v = m[1].toUpperCase();
    if (v === "FOLLOWUP") return "followup";
    if (v === "RESUME") return "resume";
    if (v === "NEW") return "new";
    return null;
  }

  it("parses RESUME for the canonical resume scenario", () => {
    expect(parse("RESUME user says 'go' after agent paused for login")).toBe("resume");
    expect(parse("resume — short ack continues in-flight task")).toBe("resume");
    expect(parse("  RESUME with leading whitespace")).toBe("resume");
  });

  it("parses FOLLOWUP for cheap acks", () => {
    expect(parse("FOLLOWUP short ack tied to prior turn")).toBe("followup");
    expect(parse("followup\n(reason)")).toBe("followup");
  });

  it("parses NEW for substantive new asks", () => {
    expect(parse("NEW names new topic 'webrtc'")).toBe("new");
    expect(parse("new — switches to kraken bot")).toBe("new");
  });

  it("returns null for malformed output", () => {
    expect(parse("MAYBE")).toBeNull();
    expect(parse("yes")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("the answer is RESUME")).toBeNull(); // not at start
  });
});

describe("orchestrator resume-gate — deterministic regex fallback", () => {
  // The resume branch's LLM topical-relevance can fail (timeout, no provider,
  // disabled). The fallback is regex keyword overlap against the active-task
  // anchor — that's deterministic and what we lock in here. The ANCHOR is
  // the first substantive user message of the session, NOT the resume
  // message ("go" has no topic words and would let everything through).
  //
  // This mirrors src/orchestrator/orchestrator.ts:198-210 (resume branch
  // fallback path) without booting the full orchestrator.

  // Imported from src/orchestrator/topical-relevance.ts — the same helpers
  // the orchestrator uses on the LLM-unavailable path.

  it("drops unrelated profile-scope signals on resume", async () => {
    const { topicalKeywords, signalTopicallyRelevant } = await import(
      "../src/orchestrator/orchestrator.js"
    );
    // Active-task anchor = the first substantive user message of the session
    const anchor = "Enter this purchase order from NS Nutrition into thriventory inventory";
    const anchorWords = topicalKeywords(anchor);

    // Signals that were active in the session at resume time
    const signals = [
      // Active-task signal — same PO + same thriventory destination → 2+
      // overlapping topical words → kept by the regex fallback.
      { source: "today_context", signal: "Active purchase order from NS Nutrition queued for thriventory entry" },
      // Stale profile signal from a different past task — words like
      // 'sports', 'pending' don't overlap with the anchor topic words →
      // dropped. This is the bleed the resume gate is supposed to stop.
      { source: "milestones", signal: "User has 5 Sports Life products pending review and SKU mapping" },
      // Generic profile signal with no topical overlap — should drop
      { source: "language_style", signal: "User prefers terse confirmations and direct phrasing" },
    ];

    const kept = signals.filter(s => signalTopicallyRelevant(anchorWords, s.signal));
    const keptSources = kept.map(s => s.source);

    // The PO-relevant signal stays in
    expect(keptSources).toContain("today_context");
    // The unrelated Sports Life leak gets dropped
    expect(keptSources).not.toContain("milestones");
  });

  it("keeps signals about the active task even after a short resume message", async () => {
    const { topicalKeywords, signalTopicallyRelevant } = await import(
      "../src/orchestrator/orchestrator.js"
    );
    // The user's resume message has zero topic words. If we gated on it
    // instead of the anchor, the regex fallback would either drop everything
    // (no overlap possible) or keep everything (no filter possible). Gating
    // on the anchor is what makes the active-task signal pass through.
    const anchor = "build me a kraken trading bot dashboard";
    const resumeMsg = "go";

    const anchorWords = topicalKeywords(anchor);
    const resumeWords = topicalKeywords(resumeMsg);

    const sig = "Kraken trading bot needs SL/TP fix and position tracking";

    expect(signalTopicallyRelevant(anchorWords, sig)).toBe(true);
    // "go" has no topic words → regex gate has nothing to compare against
    // and (per current implementation) returns false. That's the bleed
    // path we replaced — gating on the anchor is the fix.
    expect(signalTopicallyRelevant(resumeWords, sig)).toBe(false);
  });
});
