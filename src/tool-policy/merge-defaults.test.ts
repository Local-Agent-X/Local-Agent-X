import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_POLICY } from "./default-rules.js";
import { mergeWithDefaults, snapshotHashOf, stampedDefaultPolicy } from "./merge-defaults.js";
import type { ToolPolicyConfig, ToolPolicyRule } from "./types.js";

// The class bug this module fixes: a default rule's DECISION changed in code
// under a stable id (flag-browser-evaluate went confirm → allow in cf977d9a),
// but the boot merge always trusted the on-disk decision, so every existing
// install kept the retired decision forever — restarts could never fix it.
// These tests pin the reconciliation contract: stale default snapshots refresh
// from code, genuine user edits are preserved.

const EVALUATE_DEFAULT = DEFAULT_POLICY.rules.find((r) => r.id === "flag-browser-evaluate")!;

function cfg(rules: ToolPolicyRule[]): ToolPolicyConfig {
  return { defaultDecision: "deny", rules };
}

function mergedRule(rules: ToolPolicyRule[], id: string): ToolPolicyRule {
  const found = mergeWithDefaults(cfg(rules)).rules.find((r) => r.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe("guards on the scenario itself", () => {
  it("the current code default for flag-browser-evaluate is allow (the flip that motivated all this)", () => {
    expect(EVALUATE_DEFAULT.decision).toBe("allow");
  });
});

describe("legacy (unstamped) rules", () => {
  it("a known-retired decision under a default id is a stale snapshot — refreshed to the current default", () => {
    const stale: ToolPolicyRule = {
      id: "flag-browser-evaluate",
      tool: "browser",
      action: "evaluate",
      decision: "confirm",
      reason: "Browser JS evaluation — flagged for review",
      priority: 100,
    };
    const merged = mergedRule([stale], "flag-browser-evaluate");
    expect(merged.decision).toBe("allow");
    expect(merged.reason).toBe(EVALUATE_DEFAULT.reason);
    expect(merged.snapshotHash).toBe(snapshotHashOf(EVALUATE_DEFAULT));
  });

  it("a decision NOT in the retired table is treated as a user edit and preserved (fail safe)", () => {
    const userDeny: ToolPolicyRule = {
      id: "flag-browser-evaluate",
      tool: "browser",
      action: "evaluate",
      decision: "deny",
      reason: "I never want page JS",
      priority: 100,
    };
    const merged = mergedRule([userDeny], "flag-browser-evaluate");
    expect(merged.decision).toBe("deny");
    expect(merged.reason).toBe("I never want page JS");
    expect(merged.snapshotHash).toBeUndefined();
  });

  it("a user deny on a toggleable rule (Settings UI, pre-stamping) is preserved", () => {
    const bashDefault = DEFAULT_POLICY.rules.find((r) => r.id === "allow-bash-limited")!;
    expect(bashDefault.decision).toBe("allow");
    const toggledOff: ToolPolicyRule = { ...bashDefault, decision: "deny", reason: "Disabled via settings" };
    delete toggledOff.snapshotHash;
    const merged = mergedRule([toggledOff], "allow-bash-limited");
    expect(merged.decision).toBe("deny");
  });

  it("fields already in sync with the current default get stamped (bootstraps tracking, same behavior)", () => {
    const inSync: ToolPolicyRule = { ...EVALUATE_DEFAULT };
    delete inSync.snapshotHash;
    const merged = mergedRule([inSync], "flag-browser-evaluate");
    expect(merged.decision).toBe("allow");
    expect(merged.snapshotHash).toBe(snapshotHashOf(EVALUATE_DEFAULT));
  });
});

describe("stamped rules", () => {
  it("untouched snapshot (fields match stamp) follows a code default change wholesale", () => {
    // Simulate: code wrote confirm+stamp in an old version, then the default
    // moved to allow. Fields still match the stamp → user never touched it.
    const oldEra: ToolPolicyRule = {
      id: "flag-browser-evaluate",
      tool: "browser",
      action: "evaluate",
      decision: "confirm",
      reason: "Browser JS evaluation — flagged for review",
      priority: 100,
    };
    oldEra.snapshotHash = snapshotHashOf(oldEra);
    const merged = mergedRule([oldEra], "flag-browser-evaluate");
    expect(merged.decision).toBe("allow");
    expect(merged.snapshotHash).toBe(snapshotHashOf(EVALUATE_DEFAULT));
  });

  it("user-diverged rule (fields drifted from stamp) keeps the user's decision", () => {
    // Simulate: code wrote allow+stamp, then the user flipped it to deny
    // (Settings toggle or hand-edit — neither updates the stamp).
    const diverged: ToolPolicyRule = {
      ...EVALUATE_DEFAULT,
      decision: "deny",
      snapshotHash: snapshotHashOf(EVALUATE_DEFAULT),
    };
    const merged = mergedRule([diverged], "flag-browser-evaluate");
    expect(merged.decision).toBe("deny");
  });

  it("user-diverged rule still gets its matching pattern refreshed from code", () => {
    const diverged: ToolPolicyRule = {
      ...EVALUATE_DEFAULT,
      tool: "browser_old_name",
      decision: "deny",
      snapshotHash: snapshotHashOf(EVALUATE_DEFAULT),
    };
    const merged = mergedRule([diverged], "flag-browser-evaluate");
    expect(merged.tool).toBe("browser");
    expect(merged.decision).toBe("deny");
  });
});

describe("non-default rules and stamping infrastructure", () => {
  it("a user-authored rule (id unknown to code) passes through untouched", () => {
    const custom: ToolPolicyRule = { id: "my-rule", tool: "my_tool", decision: "deny", reason: "mine", priority: 5 };
    const merged = mergedRule([custom], "my-rule");
    expect(merged).toEqual(custom);
  });
});

// A default code retires (a pre-approval for tools nobody wrote, a deny the
// owner lifted) used to stay on every existing install as "user-authored",
// because the merge kept anything whose id code no longer ships.
describe("retired defaults", () => {
  const retiredAllow = (): ToolPolicyRule => {
    const rule: ToolPolicyRule = { id: "allow-payment", tool: "payment_*", decision: "allow", reason: "Payment ops", priority: 40, constraints: { maxCallsPerSession: 30 } };
    return { ...rule, snapshotHash: snapshotHashOf(rule) };
  };

  it("a stamped, untouched rule code no longer ships is dropped", () => {
    expect(DEFAULT_POLICY.rules.some((r) => r.id === "allow-payment")).toBe(false);
    expect(mergeWithDefaults(cfg([retiredAllow()])).rules.find((r) => r.id === "allow-payment")).toBeUndefined();
  });

  it("a retired deny goes too — the owner lifting a default reaches existing installs", () => {
    const deny: ToolPolicyRule = { id: "deny-bash-rm-rf", tool: "bash", decision: "deny", reason: "rm -rf", priority: 100 };
    const stamped = { ...deny, snapshotHash: snapshotHashOf(deny) };
    expect(mergeWithDefaults(cfg([stamped])).rules.find((r) => r.id === "deny-bash-rm-rf")).toBeUndefined();
  });

  it("a retired rule the user edited is theirs now, and stays", () => {
    const edited = { ...retiredAllow(), decision: "confirm" as const };
    expect(mergedRule([edited], "allow-payment").decision).toBe("confirm");
  });

  it("an unstamped rule code no longer ships can't be proven untouched, and stays", () => {
    const { snapshotHash: _unstamped, ...legacy } = retiredAllow();
    expect(mergedRule([legacy], "allow-payment")).toEqual(legacy);
  });

  it("the drop is written back, so the on-disk snapshot heals", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-retire-"));
    try {
      const path = join(dir, "tool-policy.json");
      mergeWithDefaults(cfg([...stampedDefaultPolicy().rules, retiredAllow()]), path);
      const onDisk = JSON.parse(readFileSync(path, "utf-8")) as ToolPolicyConfig;
      expect(onDisk.rules.some((r) => r.id === "allow-payment")).toBe(false);
      expect(onDisk.rules.length).toBe(DEFAULT_POLICY.rules.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing default rules are added stamped", () => {
    const merged = mergeWithDefaults(cfg([]));
    expect(merged.rules.length).toBe(DEFAULT_POLICY.rules.length);
    for (const rule of merged.rules) {
      expect(rule.snapshotHash).toBe(snapshotHashOf(rule));
    }
  });

  it("stampedDefaultPolicy stamps every rule with its own field hash", () => {
    const stamped = stampedDefaultPolicy();
    expect(stamped.rules.length).toBe(DEFAULT_POLICY.rules.length);
    for (const rule of stamped.rules) {
      expect(rule.snapshotHash).toBe(snapshotHashOf(rule));
    }
  });

  it("snapshotHashOf ignores code-owned fields (reason/tool/action) and normalizes absent priority/constraints", () => {
    expect(snapshotHashOf({ decision: "allow" })).toBe(
      snapshotHashOf({ decision: "allow", priority: 0, constraints: undefined }),
    );
    const a = snapshotHashOf({ decision: "allow", priority: 40, constraints: { maxCallsPerSession: 100 } });
    const b = snapshotHashOf({ decision: "allow", priority: 40, constraints: { maxCallsPerSession: 100 } });
    expect(a).toBe(b);
    expect(snapshotHashOf({ decision: "deny" })).not.toBe(snapshotHashOf({ decision: "allow" }));
  });
});
