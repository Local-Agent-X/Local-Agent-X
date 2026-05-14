import { describe, it, expect } from "vitest";
import { evaluate, type RulePack } from "../../src/tool-policy/evaluator.js";

// Regression test for DRY-AUDIT.md F4 — four independent policy layers
// unified into one evaluator with pluggable rule packs. The evaluator
// must (a) short-circuit on the first deny and (b) name the pack that
// denied so the audit trail isn't lost in the refactor.

describe("policy evaluator (F4 closure)", () => {
  const allowPack: RulePack = {
    id: "always-allow",
    priority: 1,
    rules: [],
    evaluate: () => ({ allowed: true }),
  };

  const denySecurity: RulePack = {
    id: "security-layer",
    priority: 10,
    rules: [],
    evaluate: () => ({ allowed: false, reason: "security denied", ruleId: "sec.1" }),
  };

  const denyDefault: RulePack = {
    id: "default-policy",
    priority: 20,
    rules: [],
    evaluate: () => ({ allowed: false, reason: "policy denied" }),
  };

  it("returns allowed when every pack allows", async () => {
    const decision = await evaluate(
      { id: "t1", name: "read", args: {} },
      [allowPack, allowPack],
      { sessionId: "s", callContext: "local" },
    );
    expect(decision.allowed).toBe(true);
  });

  it("names the pack that denied (single-pack block)", async () => {
    const decision = await evaluate(
      { id: "t1", name: "write", args: {} },
      [allowPack, denySecurity, allowPack],
      { sessionId: "s", callContext: "local" },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.deniedBy.packId).toBe("security-layer");
      expect(decision.deniedBy.ruleId).toBe("sec.1");
      expect(decision.reason).toBe("security denied");
    }
  });

  it("short-circuits on first deny in priority order", async () => {
    // security-layer (priority 10) runs before default-policy (priority 20);
    // the lower-priority pack should never be consulted.
    let defaultRan = false;
    const tracerDefault: RulePack = {
      id: "default-policy",
      priority: 20,
      rules: [],
      evaluate: () => {
        defaultRan = true;
        return { allowed: false, reason: "should not reach" };
      },
    };
    const decision = await evaluate(
      { id: "t1", name: "bash", args: {} },
      [denySecurity, tracerDefault],
      { sessionId: "s", callContext: "local" },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.deniedBy.packId).toBe("security-layer");
    }
    expect(defaultRan).toBe(false);
  });

  it("respects pack priority regardless of array order", async () => {
    // denyDefault has priority 20; denySecurity has priority 10.
    // Passing denyDefault first should NOT change the result — security
    // (lower priority number) must be evaluated first.
    const decision = await evaluate(
      { id: "t1", name: "bash", args: {} },
      [denyDefault, denySecurity],
      { sessionId: "s", callContext: "local" },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.deniedBy.packId).toBe("security-layer");
    }
  });
});
