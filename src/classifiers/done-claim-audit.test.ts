import { describe, it, expect, vi, beforeEach } from "vitest";

// classifySchema routes through the canonical chokepoint; the mock resolves
// RAW model text so the real JSON.parse → zod pipeline runs.
const classifyWithLLM = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>): Promise<string | null> => null),
);
vi.mock("./classify-with-llm.js", () => ({
  classifyWithLLM: (...args: unknown[]) => classifyWithLLM(...(args as [Record<string, unknown>])),
}));

import { auditDoneClaim } from "./done-claim-audit.js";

type Llm = (system: string, user: string) => Promise<string | null>;
const llmReturning = (...replies: (string | null)[]) => {
  const fn = vi.fn<Llm>();
  for (const r of replies) fn.mockResolvedValueOnce(r);
  return fn;
};

const realInput = {
  userRequest: "remove every tailnet reference from the app",
  evidence: "diff --git a/x.ts b/x.ts\n- tailnetAddr\n+ desktopAddr",
};

beforeEach(() => vi.clearAllMocks());

describe("auditDoneClaim — schema-validated verdict (bias-to-MET)", () => {
  it('{"unmet":[]} is the MET verdict — an empty finding list', async () => {
    const llm = llmReturning('{"unmet":[]}');
    expect(await auditDoneClaim({ ...realInput, _llm: llm })).toEqual([]);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("unmet findings come back verbatim, whitespace-only entries dropped", async () => {
    const llm = llmReturning(
      '{"unmet":["\\"remove every tailnet ref\\" — voice/errors.ts still shows \\"Tailscale network\\"","   ","\\"rename the field\\" — chat/ subtree untouched"]}',
    );
    expect(await auditDoneClaim({ ...realInput, _llm: llm })).toEqual([
      '"remove every tailnet ref" — voice/errors.ts still shows "Tailscale network"',
      '"rename the field" — chat/ subtree untouched',
    ]);
  });

  it("caps the findings at 5", async () => {
    const items = Array.from({ length: 9 }, (_, i) => `"item ${i + 1}"`).join(",");
    const llm = llmReturning(`{"unmet":[${items}]}`);
    expect(await auditDoneClaim({ ...realInput, _llm: llm })).toHaveLength(5);
  });

  it("a fenced JSON reply still parses", async () => {
    const llm = llmReturning('```json\n{"unmet":[]}\n```');
    expect(await auditDoneClaim({ ...realInput, _llm: llm })).toEqual([]);
  });

  it("no verdict on prose or a wrong shape — single retry, then null (gate no-op)", async () => {
    const llm = llmReturning("The changes look mostly fine to me.", '{"unmet":"none"}');
    expect(await auditDoneClaim({ ...realInput, _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("LLM unavailable → null without a retry", async () => {
    const llm = llmReturning(null);
    expect(await auditDoneClaim({ ...realInput, _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe("auditDoneClaim — input guards (no LLM call wasted)", () => {
  it("a too-short request or empty evidence returns null without calling the classifier", async () => {
    expect(await auditDoneClaim({ userRequest: "fix it", evidence: "diff --git a b" })).toBeNull();
    expect(await auditDoneClaim({ userRequest: "remove every tailnet reference from the app", evidence: "   " })).toBeNull();
    expect(classifyWithLLM).not.toHaveBeenCalled();
  });

  it("a real request+evidence pair reaches the chokepoint on the active tier", async () => {
    classifyWithLLM.mockResolvedValueOnce('{"unmet":["item"]}');
    const out = await auditDoneClaim(realInput);
    expect(out).toEqual(["item"]);
    const opts = classifyWithLLM.mock.calls[0][0];
    expect(opts.category).toBe("spec-audit");
    expect(opts.modelTier).toBe("active");
    expect(opts.envDisableVar).toBe("LAX_SPEC_AUDIT");
    expect(opts.userPrompt).toContain("tailnetAddr");
  });
});
