// The claims record of a collab: reading the lines members write for the app,
// and which claims are confirmed, conceded or still disputed (ADR 0007 §9).
import { describe, expect, it } from "vitest";
import type { Collab } from "./collab.js";
import {
  applyResponses, applyVerdicts, challengersOf, claimStatus, disputeSignature, disputesMissingFrom,
  openDisputes, parseClaims, MAX_CLAIMS_PER_MEMBER,
} from "./collab-claims.js";

const REPORT = [
  "## Summary", "Lithium iron phosphate lasts longest.", "",
  "C9: not a claim, this line is above the heading", "",
  "## CLAIMS",
  "C1: LFP cells keep 80% capacity after 6,000 cycles | SOURCE: https://example.org/lfp-study",
  "- **C2:** NMC cells fade faster in heat | SOURCE: [the paper](https://example.org/nmc).",
  "C2: a second line with the same number is ignored | SOURCE: https://example.org/dup",
  "C3. A claim with no link",
  "Some closing words.",
].join("\n");

function collab(): Collab {
  return {
    id: "collab-1", hostId: "host", hostTitle: "Host", question: "Q?", steps: 3, depth: "standard", phase: "research", disputeRound: 0,
    state: "running", startedAt: "2026-11-11T00:00:00.000Z",
    members: [
      { sessionId: "m1", provider: "anthropic", model: "opus", label: "opus", letter: "A", report: "r" },
      { sessionId: "m2", provider: "codex", model: "gpt", label: "gpt", letter: "B", report: "r" },
      { sessionId: "m3", provider: "xai", model: "grok", label: "grok", letter: "C", report: "r" },
    ],
    claims: [...parseClaims(REPORT, "A"), ...parseClaims("CLAIMS\nC1: Sodium cells are cheaper | SOURCE: https://example.org/na", "B")],
  };
}

describe("reading a report's claims", () => {
  it("takes the lines after the CLAIMS heading, with the member's letter, the claim and the link it opened", () => {
    expect(parseClaims(REPORT, "A")).toEqual([
      { id: "A1", owner: "A", text: "LFP cells keep 80% capacity after 6,000 cycles", source: "https://example.org/lfp-study", verdicts: [] },
      { id: "A2", owner: "A", text: "NMC cells fade faster in heat", source: "https://example.org/nmc", verdicts: [] },
      { id: "A3", owner: "A", text: "A claim with no link", source: "", verdicts: [] },
    ]);
  });

  it("reads claim lines with no heading, keeps at most twelve, and finds none in prose", () => {
    const many = Array.from({ length: 20 }, (_, i) => `C${i + 1}: claim ${i + 1} | SOURCE: https://e.org/${i}`).join("\n");
    expect(parseClaims(many, "B")).toHaveLength(MAX_CLAIMS_PER_MEMBER);
    expect(parseClaims("I found that batteries last. Claims: many.", "A")).toEqual([]);
  });
});

describe("what becomes of a claim", () => {
  it("is unchecked until another member gives a verdict, and a member cannot rule on its own", () => {
    const c = collab();
    expect(claimStatus(c.claims[0])).toBe("unchecked");
    expect(applyVerdicts(c, "A", "VERDICTS\nA1: CONFIRMED\nB1: CONFIRMED\nZ9: CONFIRMED")).toBe(1);
    expect(claimStatus(c.claims[0])).toBe("unchecked");
    expect(claimStatus(c.claims.find((x) => x.id === "B1")!)).toBe("confirmed");
  });

  it("records confirmed, challenged and unverified, one verdict per member per claim", () => {
    const c = collab();
    applyVerdicts(c, "B", [
      "## VERDICTS",
      "A1: CONFIRMED",
      "- A2: CHALLENGED | The paper tested one chemistry only | SOURCE: https://example.org/nmc-limits",
      "[A3] - UNVERIFIED | no source to open",
      "A1: CHALLENGED | a second verdict on the same claim is ignored",
    ].join("\n"));
    const [a1, a2, a3] = c.claims;
    expect(claimStatus(a1)).toBe("confirmed");
    expect(claimStatus(a2)).toBe("disputed");
    expect(a2.verdicts).toEqual([{ by: "B", verdict: "challenged", why: "The paper tested one chemistry only", source: "https://example.org/nmc-limits" }]);
    expect(claimStatus(a3)).toBe("unverified");
    expect(openDisputes(c).map((x) => x.id)).toEqual(["A2"]);
    expect(challengersOf(a2)).toEqual(["B"]);
  });

  it("a challenge the maker concedes is conceded; one it defends stays disputed, as fact or as judgment", () => {
    const c = collab();
    applyVerdicts(c, "B", "A1: CHALLENGED | wrong | SOURCE: https://e.org/x\nA2: CHALLENGED | wrong\nA3: CHALLENGED | wrong");
    applyResponses(c, "A", [
      "RESPONSES",
      "A1: CONCEDED | their source is the manufacturer's own data",
      "A2: DEFENDED | FACT | the paper covers three chemistries | SOURCE: https://example.org/nmc",
      "A3: DEFENDED | JUDGMENT | we weigh cycle life against cost differently",
      "B1: CONCEDED | not its claim, so this is ignored",
    ].join("\n"));
    expect(c.claims.map(claimStatus)).toEqual(["conceded", "disputed", "disputed", "unchecked"]);
    expect(c.claims[1].response).toEqual({ kind: "defended", judgment: false, text: "the paper covers three chemistries", source: "https://example.org/nmc" });
    expect(c.claims[2].response?.judgment).toBe(true);
    // More evidence will not settle a dispute of judgment: no further round on it.
    expect(openDisputes(c).map((x) => x.id)).toEqual(["A2", "A3"]);
    expect(openDisputes(c, true).map((x) => x.id)).toEqual(["A2"]);
  });

  it("a challenger that withdraws settles the claim; one that maintains keeps it open with its new evidence", () => {
    const c = collab();
    applyVerdicts(c, "B", "A1: CHALLENGED | wrong\nA2: CHALLENGED | wrong");
    applyVerdicts(c, "C", "A2: CHALLENGED | also wrong");
    const before = disputeSignature(c);
    applyResponses(c, "B", "A1: WITHDRAWN | the primary source agrees\nA2: MAINTAINED | still one chemistry | SOURCE: https://e.org/new");
    expect(claimStatus(c.claims[0])).toBe("confirmed");
    expect(challengersOf(c.claims[1])).toEqual(["B", "C"]);
    expect(c.claims[1].verdicts[0]).toMatchObject({ why: "still one chemistry", source: "https://e.org/new" });
    expect(disputeSignature(c)).not.toBe(before);
    const mid = disputeSignature(c);
    applyResponses(c, "C", "A2: MAINTAINED | same");
    expect(disputeSignature(c)).toBe(mid);
    // The maker cannot withdraw a challenge, and a settled claim takes no more lines.
    applyResponses(c, "A", "A2: WITHDRAWN | nice try\nA1: CONCEDED | too late");
    expect(challengersOf(c.claims[1])).toEqual(["B", "C"]);
    expect(claimStatus(c.claims[0])).toBe("confirmed");
  });

  it("says which open disputes a result does not name", () => {
    const c = collab();
    applyVerdicts(c, "B", "A1: CHALLENGED | x\nA2: CHALLENGED | y");
    expect(disputesMissingFrom(c, "Settled here: [A1] holds. Unresolved: none of note. Also A21.")).toEqual(["A2"]);
    expect(disputesMissingFrom(c, "[A1] and [A2]")).toEqual([]);
  });
});
