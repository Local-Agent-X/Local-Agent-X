import { describe, it, expect, vi, beforeEach } from "vitest";

// classifySchema routes through the canonical chokepoint; the mock resolves
// RAW model text so the real JSON.parse → zod pipeline runs.
const classifyWithLLM = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>): Promise<string | null> => null),
);
vi.mock("./classify-with-llm.js", () => ({
  classifyWithLLM: (...args: unknown[]) => classifyWithLLM(...(args as [Record<string, unknown>])),
}));

import { auditRegressionRisk } from "./regression-audit.js";

type Llm = (system: string, user: string) => Promise<string | null>;
const llmReturning = (...replies: (string | null)[]) => {
  const fn = vi.fn<Llm>();
  for (const r of replies) fn.mockResolvedValueOnce(r);
  return fn;
};

const realInput = {
  evidence: "diff --git a/queries.ts b/queries.ts\n- return jobs.filter(withinRange)\n+ return jobs",
};

beforeEach(() => vi.clearAllMocks());

describe("auditRegressionRisk — schema-validated verdict (bias-to-no-finding)", () => {
  it('{"findings":[]} is the clean verdict — an empty list', async () => {
    const llm = llmReturning('{"findings":[]}');
    expect(await auditRegressionRisk({ ...realInput, _llm: llm })).toEqual([]);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("findings come back verbatim, whitespace-only entries dropped", async () => {
    const llm = llmReturning(
      '{"findings":["DATA EXPOSURE — mobile/[id]/page.tsx — payments field reaches the client unfiltered","   ","ERROR-HANDLING — actions.ts — catch routes segment failures to updateJob"]}',
    );
    expect(await auditRegressionRisk({ ...realInput, _llm: llm })).toEqual([
      "DATA EXPOSURE — mobile/[id]/page.tsx — payments field reaches the client unfiltered",
      "ERROR-HANDLING — actions.ts — catch routes segment failures to updateJob",
    ]);
  });

  it("caps the findings at 5", async () => {
    const items = Array.from({ length: 9 }, (_, i) => `"finding ${i + 1}"`).join(",");
    const llm = llmReturning(`{"findings":[${items}]}`);
    expect(await auditRegressionRisk({ ...realInput, _llm: llm })).toHaveLength(5);
  });

  it("a fenced JSON reply still parses", async () => {
    const llm = llmReturning('```json\n{"findings":[]}\n```');
    expect(await auditRegressionRisk({ ...realInput, _llm: llm })).toEqual([]);
  });

  it("no verdict on prose or a wrong shape — single retry, then null (gate no-op)", async () => {
    const llm = llmReturning("This all looks fine to me.", '{"findings":"none"}');
    expect(await auditRegressionRisk({ ...realInput, _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("LLM unavailable → null without a retry", async () => {
    const llm = llmReturning(null);
    expect(await auditRegressionRisk({ ...realInput, _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe("auditRegressionRisk — input guards (no LLM call wasted)", () => {
  it("empty evidence returns null without calling the classifier", async () => {
    expect(await auditRegressionRisk({ evidence: "   " })).toBeNull();
    expect(classifyWithLLM).not.toHaveBeenCalled();
  });

  it("real evidence reaches the chokepoint on the active tier", async () => {
    classifyWithLLM.mockResolvedValueOnce('{"findings":["item"]}');
    const out = await auditRegressionRisk(realInput);
    expect(out).toEqual(["item"]);
    const opts = classifyWithLLM.mock.calls[0][0];
    expect(opts.category).toBe("regression-audit");
    expect(opts.modelTier).toBe("active");
    expect(opts.envDisableVar).toBe("LAX_REGRESSION_AUDIT");
    expect(opts.userPrompt).toContain("withinRange");
  });

  it("providerOverride passes straight through to classifyWithLLM untouched", async () => {
    classifyWithLLM.mockResolvedValueOnce('{"findings":[]}');
    const override = { provider: "anthropic", apiKey: "k", model: "claude-opus-5" };
    await auditRegressionRisk({ ...realInput, providerOverride: override });
    const opts = classifyWithLLM.mock.calls[0][0];
    expect(opts.providerOverride).toEqual(override);
  });

  it("no providerOverride given → undefined reaches classifyWithLLM (same-model default)", async () => {
    classifyWithLLM.mockResolvedValueOnce('{"findings":[]}');
    await auditRegressionRisk(realInput);
    const opts = classifyWithLLM.mock.calls[0][0];
    expect(opts.providerOverride).toBeUndefined();
  });
});
