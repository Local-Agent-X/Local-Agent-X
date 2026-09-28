import { describe, it, expect } from "vitest";
import { parseReviewAnswer } from "./publish-review-verdict.js";

const RED_ROW = "red | supabase/migrations/0042_email_rls.sql:12 | policy lets any member select every recipient email | leaks PII across tenants; 0031 fixed the same hole for sms_* | scope the policy to auth.uid() like 0031";

describe("parseReviewAnswer — the strict contract", () => {
  it("GREEN with no findings is one line", () => {
    expect(parseReviewAnswer("VERDICT: GREEN")).toEqual({ ok: true, verdict: "GREEN", findings: [] });
  });

  it("parses every finding's five fields", () => {
    const parsed = parseReviewAnswer(`VERDICT: RED\n${RED_ROW}\namber | src/dedupe.ts:40 | 24h check then insert is not atomic | two sends can pass at once | unique constraint on (recipient, day)`);
    expect(parsed).toEqual({
      ok: true,
      verdict: "RED",
      findings: [
        {
          severity: "red",
          location: "supabase/migrations/0042_email_rls.sql:12",
          problem: "policy lets any member select every recipient email",
          why: "leaks PII across tenants; 0031 fixed the same hole for sms_*",
          fix: "scope the policy to auth.uid() like 0031",
        },
        expect.objectContaining({ severity: "amber", location: "src/dedupe.ts:40" }),
      ],
    });
  });

  it("AMBER stays AMBER with amber and yellow findings", () => {
    const parsed = parseReviewAnswer("VERDICT: AMBER\namber | a.ts:1 | p | w | f\nyellow | b.ts:2 | p | w | f");
    expect(parsed.ok && parsed.verdict).toBe("AMBER");
  });

  it("never lets the stated verdict be lower than the worst finding", () => {
    const parsed = parseReviewAnswer(`VERDICT: GREEN\n${RED_ROW}`);
    expect(parsed.ok && parsed.verdict).toBe("RED");
    const amber = parseReviewAnswer("VERDICT: GREEN\namber | a.ts:1 | p | w | f");
    expect(amber.ok && amber.verdict).toBe("AMBER");
  });

  it("tolerates a code fence around an otherwise exact answer", () => {
    expect(parseReviewAnswer("```\nVERDICT: GREEN\n```").ok).toBe(true);
  });

  it("uppercase severities are the same severity", () => {
    const parsed = parseReviewAnswer("VERDICT: RED\nRED | a.ts:1 | p | w | f");
    expect(parsed.ok && parsed.findings[0].severity).toBe("red");
  });

  const GARBAGE: Array<[string, string]> = [
    ["", "empty"],
    ["Looks good to me!", "prose, no verdict"],
    ["**VERDICT: GREEN**", "markdown around the verdict"],
    ["Here is my review.\nVERDICT: GREEN", "preamble before the verdict"],
    ["VERDICT: PASS", "unknown verdict word"],
    ["VERDICT: GREEN\nOverall the change is fine.", "trailing prose"],
    [`VERDICT: RED\n- ${RED_ROW}`, "a bulleted finding"],
    ["VERDICT: RED\nred | a.ts:1 | problem | why", "four fields"],
    ["VERDICT: RED\ncritical | a.ts:1 | p | w | f", "unknown severity"],
    ["VERDICT: AMBER\namber | a.ts:1 |  | w | f", "an empty field"],
  ];
  for (const [text, what] of GARBAGE) {
    it(`FAILED, never GREEN: ${what}`, () => {
      const parsed = parseReviewAnswer(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(10);
    });
  }
});
