import { describe, it, expect, vi, beforeEach } from "vitest";

// Spend-cap pack — opt-in USD budget gate. Mock the cost-tracker (so spend is
// deterministic) and the runtime config (so the budgets are set per-case),
// keeping the test hermetic — no disk, no real usage log.

const getTodayCost = vi.fn();
const getSessionCost = vi.fn();
const getRuntimeConfig = vi.fn();

vi.mock("../../src/cost-tracker.js", () => ({
  getTodayCost: () => getTodayCost(),
  getSessionCost: (sessionId: string) => getSessionCost(sessionId),
}));

vi.mock("../../src/config.js", () => ({
  getRuntimeConfig: () => getRuntimeConfig(),
}));

import { makeSpendCapPack } from "../../src/tool-policy/packs/spend-cap-pack.js";

const CALL = { id: "t1", name: "bash", args: {} };
const CTX = { sessionId: "s1", callContext: "local" as const };

function setConfig(cfg: { dailyBudgetUsd?: number; sessionBudgetUsd?: number }) {
  getRuntimeConfig.mockReturnValue(cfg);
}

describe("spend-cap pack", () => {
  beforeEach(() => {
    getTodayCost.mockReset();
    getSessionCost.mockReset();
    getRuntimeConfig.mockReset();
    getTodayCost.mockReturnValue({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    getSessionCost.mockReturnValue({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("allows when both budgets are unset (disabled by default)", () => {
    setConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0 });
    getTodayCost.mockReturnValue({ costUsd: 999, inputTokens: 0, outputTokens: 0 });
    getSessionCost.mockReturnValue({ costUsd: 999, inputTokens: 0, outputTokens: 0 });
    const decision = makeSpendCapPack().evaluate(CALL, CTX);
    expect(decision.allowed).toBe(true);
  });

  it("denies with the daily reason once today's cost reaches dailyBudgetUsd", () => {
    setConfig({ dailyBudgetUsd: 5 });
    getTodayCost.mockReturnValue({ costUsd: 5.5, inputTokens: 0, outputTokens: 0 });
    const decision = makeSpendCapPack().evaluate(CALL, CTX);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.ruleId).toBe("spend-cap.daily");
      expect(decision.reason).toBe("Daily spend ($5.50) has reached the configured budget ($5.00).");
      expect(decision.recovery).toContain("daily budget");
      expect(decision.userHint).toBeTruthy();
    }
  });

  it("denies with the session reason once session cost reaches sessionBudgetUsd", () => {
    setConfig({ sessionBudgetUsd: 2 });
    getSessionCost.mockReturnValue({ costUsd: 2, inputTokens: 0, outputTokens: 0 });
    const decision = makeSpendCapPack().evaluate(CALL, CTX);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.ruleId).toBe("spend-cap.session");
      expect(decision.reason).toBe("Session spend ($2.00) has reached the configured budget ($2.00).");
      expect(decision.recovery).toContain("session budget");
    }
    expect(getSessionCost).toHaveBeenCalledWith("s1");
  });

  it("allows when spend is under both configured budgets", () => {
    setConfig({ dailyBudgetUsd: 10, sessionBudgetUsd: 5 });
    getTodayCost.mockReturnValue({ costUsd: 3, inputTokens: 0, outputTokens: 0 });
    getSessionCost.mockReturnValue({ costUsd: 1, inputTokens: 0, outputTokens: 0 });
    const decision = makeSpendCapPack().evaluate(CALL, CTX);
    expect(decision.allowed).toBe(true);
  });

  it("checks the daily budget before the session budget", () => {
    // Both tripped — daily (priority of the first check) should be reported.
    setConfig({ dailyBudgetUsd: 5, sessionBudgetUsd: 2 });
    getTodayCost.mockReturnValue({ costUsd: 6, inputTokens: 0, outputTokens: 0 });
    getSessionCost.mockReturnValue({ costUsd: 3, inputTokens: 0, outputTokens: 0 });
    const decision = makeSpendCapPack().evaluate(CALL, CTX);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.ruleId).toBe("spend-cap.daily");
  });
});
