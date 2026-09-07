import { describe, it, expect } from "vitest";
import {
  createConstraintLedger, formatConstraintReminder, noteFailures, normalizeReason,
} from "./constraint-ledger.js";

/** The exact write-gate rejection from the recorded 160-turn op, which the
 *  agent hit 14 times because nothing carried the lesson between turns. */
const VIEWPORT = 'Write rejected: html missing <meta name="viewport"> (required for mobile-correct rendering).';

describe("normalizeReason — the same gate through different files", () => {
  it("collapses the scratch-file rename that defeated a raw-string key", () => {
    const a = 'Write rejected for C:\\w\\_mt.html: html missing <meta name="viewport">';
    const b = 'Write rejected for C:\\w\\_prod.html: html missing <meta name="viewport">';
    expect(normalizeReason(a)).toBe(normalizeReason(b));
  });

  it("keeps genuinely different gates apart", () => {
    expect(normalizeReason(VIEWPORT)).not.toBe(
      normalizeReason("evaluate is inspection-only and cannot click, type, or mutate page controls."),
    );
  });
});

describe("noteFailures — a constraint is evidence, not a pattern list", () => {
  it("says nothing the first time a gate refuses", () => {
    const ledger = createConstraintLedger();
    const crossed = noteFailures(ledger, [{ tool: "write", reason: VIEWPORT }]);
    expect(crossed).toEqual([]);
  });

  it("recognizes the second identical refusal as deterministic", () => {
    const ledger = createConstraintLedger();
    noteFailures(ledger, [{ tool: "write", reason: `${VIEWPORT} path=/w/_mt.html` }]);
    const crossed = noteFailures(ledger, [{ tool: "write", reason: `${VIEWPORT} path=/w/_prod.html` }]);
    expect(crossed).toHaveLength(1);
    expect(crossed[0].tool).toBe("write");
    expect(crossed[0].count).toBe(2);
  });

  it("recognizes a brand-new gate it has never been taught", () => {
    // The point of deriving rather than listing: this message appears in no
    // table anywhere, and is still caught on its second occurrence.
    const ledger = createConstraintLedger();
    const novel = "Refused by some-future-gate-nobody-listed: quota exhausted for widget frobnication";
    noteFailures(ledger, [{ tool: "frobnicate", reason: novel }]);
    expect(noteFailures(ledger, [{ tool: "frobnicate", reason: novel }])).toHaveLength(1);
  });

  it("never treats a user decline as a standing constraint", () => {
    // The user may approve the same call next time — calling it deterministic
    // would be false, and would tell the model to stop asking.
    const ledger = createConstraintLedger();
    const declined = { tool: "bash", reason: "user declined", declined: true };
    noteFailures(ledger, [declined]);
    expect(noteFailures(ledger, [declined])).toEqual([]);
  });

  it("keeps different tools' identical messages separate", () => {
    const ledger = createConstraintLedger();
    noteFailures(ledger, [{ tool: "write", reason: "permission denied" }]);
    expect(noteFailures(ledger, [{ tool: "edit", reason: "permission denied" }])).toEqual([]);
  });

  it("ignores empty reasons rather than minting a blank constraint", () => {
    const ledger = createConstraintLedger();
    noteFailures(ledger, [{ tool: "write", reason: "   " }]);
    expect(noteFailures(ledger, [{ tool: "write", reason: "" }])).toEqual([]);
    expect(ledger.seen.size).toBe(0);
  });
});

describe("formatConstraintReminder", () => {
  it("is empty when nothing crossed the threshold", () => {
    expect(formatConstraintReminder([])).toBe("");
  });

  it("tells the model retrying will not work", () => {
    const text = formatConstraintReminder([{ tool: "write", reason: VIEWPORT, count: 3 }]);
    expect(text).toContain("deterministic");
    expect(text).toContain("write (3x)");
    expect(text).toContain("viewport");
  });

  it("truncates a verbose gate message instead of flooding the turn", () => {
    // The invariant is on the REASON, not the whole reminder — the fixed
    // header is ~230 chars and is not what a runaway gate message threatens.
    const long = "x".repeat(500);
    const text = formatConstraintReminder([{ tool: "write", reason: long, count: 2 }]);
    expect(text).toContain("…");
    // {10,} so the match is the reason body, not the "x" in the "(2x)" count.
    expect(text.match(/x{10,}/)![0].length).toBe(160);
  });
});
