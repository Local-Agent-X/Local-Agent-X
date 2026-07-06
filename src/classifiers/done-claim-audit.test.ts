import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./classify-with-llm.js", () => ({ classifyWithLLM: vi.fn(async () => null) }));

import { classifyWithLLM } from "./classify-with-llm.js";
import { auditDoneClaim, parseAuditVerdict } from "./done-claim-audit.js";

beforeEach(() => vi.clearAllMocks());

describe("parseAuditVerdict — bias-to-MET verdict extraction", () => {
  it("MET (any casing, trailing prose ignored) is an empty finding list", () => {
    expect(parseAuditVerdict("MET")).toEqual([]);
    expect(parseAuditVerdict("met")).toEqual([]);
    expect(parseAuditVerdict("MET — everything requested is present")).toEqual([]);
  });

  it("UNMET with numbered items returns the items, markers stripped", () => {
    expect(
      parseAuditVerdict('UNMET:\n1. "remove every tailnet ref" — voice/errors.ts still shows "Tailscale network"\n2) "rename the field" — chat/ subtree untouched'),
    ).toEqual([
      '"remove every tailnet ref" — voice/errors.ts still shows "Tailscale network"',
      '"rename the field" — chat/ subtree untouched',
    ]);
  });

  it("bullet markers and a stray code fence are tolerated", () => {
    expect(parseAuditVerdict('```\nUNMET:\n- item one\n• item two\n```')).toEqual(["item one", "item two"]);
  });

  it("caps the findings at 5", () => {
    const raw = "UNMET:\n" + Array.from({ length: 9 }, (_, i) => `${i + 1}. item ${i + 1}`).join("\n");
    expect(parseAuditVerdict(raw)).toHaveLength(5);
  });

  it("no verdict on anything else — empty, prose, or UNMET with zero items", () => {
    expect(parseAuditVerdict("")).toBeNull();
    expect(parseAuditVerdict("The changes look mostly fine to me.")).toBeNull();
    expect(parseAuditVerdict("UNMET:")).toBeNull();
    expect(parseAuditVerdict("UNMET:\n\n  \n")).toBeNull();
  });
});

describe("auditDoneClaim — input guards (no LLM call wasted)", () => {
  it("a too-short request or empty evidence returns null without calling the classifier", async () => {
    expect(await auditDoneClaim({ userRequest: "fix it", evidence: "diff --git a b" })).toBeNull();
    expect(await auditDoneClaim({ userRequest: "remove every tailnet reference from the app", evidence: "   " })).toBeNull();
    expect(classifyWithLLM).not.toHaveBeenCalled();
  });

  it("a real request+evidence pair reaches the classifier on the active tier", async () => {
    (classifyWithLLM as ReturnType<typeof vi.fn>).mockResolvedValueOnce(["item"]);
    const out = await auditDoneClaim({
      userRequest: "remove every tailnet reference from the app",
      evidence: "diff --git a/x.ts b/x.ts\n- tailnetAddr\n+ desktopAddr",
    });
    expect(out).toEqual(["item"]);
    const opts = (classifyWithLLM as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.category).toBe("spec-audit");
    expect(opts.modelTier).toBe("active");
    expect(opts.envDisableVar).toBe("LAX_SPEC_AUDIT");
    expect(opts.userPrompt).toContain("tailnetAddr");
  });
});
