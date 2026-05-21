import { describe, it, expect } from "vitest";
import type { ToolRisk } from "./risk.js";
import {
  decide,
  getProfile,
  PROFILES,
  PROFILE_NAMES,
  DEFAULT_PROFILE,
  isProfileName,
  type Decision,
  type ProfileName,
} from "./profiles.js";

const ALL_RISKS: ToolRisk[] = [
  "safe",
  "workspace-write",
  "network-read",
  "network-write",
  "shell",
  "external-comms",
  "destructive",
  "money",
  "secrets",
];

// Source of truth for the test matrix. Mirrors the rule tables in
// profiles.ts; duplicated intentionally so a regression in the module
// shows up as a test failure rather than the test silently moving with
// the bug.
const EXPECTED: Record<ProfileName, Record<ToolRisk, Decision>> = {
  Safe: {
    "safe": "allow",
    "workspace-write": "ask",
    "network-read": "allow",
    "network-write": "ask",
    "shell": "ask",
    "external-comms": "ask",
    "destructive": "deny",
    "money": "deny",
    "secrets": "deny",
  },
  Normal: {
    "safe": "allow",
    "workspace-write": "allow",
    "network-read": "allow",
    "network-write": "ask",
    "shell": "allow",
    "external-comms": "ask",
    "destructive": "ask",
    "money": "ask",
    "secrets": "ask",
  },
  Developer: {
    "safe": "allow",
    "workspace-write": "allow",
    "network-read": "allow",
    "network-write": "ask",
    "shell": "allow-with-rollback",
    "external-comms": "ask",
    "destructive": "allow-with-rollback",
    "money": "ask",
    "secrets": "ask",
  },
  Power: {
    "safe": "allow",
    "workspace-write": "allow",
    "network-read": "allow",
    "network-write": "allow",
    "shell": "allow",
    "external-comms": "allow",
    "destructive": "allow",
    "money": "ask",
    "secrets": "ask",
  },
  Autonomous: {
    "safe": "allow",
    "workspace-write": "allow-with-rollback",
    "network-read": "allow",
    "network-write": "allow",
    "shell": "allow-with-rollback",
    "external-comms": "allow",
    "destructive": "allow-with-rollback",
    "money": "allow",
    "secrets": "allow",
  },
};

describe("autonomy profiles", () => {
  it("exposes the five named profiles", () => {
    expect([...PROFILE_NAMES]).toEqual(["Safe", "Normal", "Developer", "Power", "Autonomous"]);
  });

  it("defaults to Normal", () => {
    expect(DEFAULT_PROFILE).toBe("Normal");
  });

  it("Normal allows the everyday-safe classes", () => {
    const p = getProfile("Normal");
    expect(decide(p, "safe")).toBe("allow");
    expect(decide(p, "workspace-write")).toBe("allow");
    expect(decide(p, "network-read")).toBe("allow");
    expect(decide(p, "shell")).toBe("allow");
  });

  it("Normal asks before anything irreversible or sensitive", () => {
    const p = getProfile("Normal");
    expect(decide(p, "network-write")).toBe("ask");
    expect(decide(p, "external-comms")).toBe("ask");
    expect(decide(p, "destructive")).toBe("ask");
    expect(decide(p, "money")).toBe("ask");
    expect(decide(p, "secrets")).toBe("ask");
  });

  it("Developer wraps shell + destructive in rollback", () => {
    const p = getProfile("Developer");
    expect(decide(p, "shell")).toBe("allow-with-rollback");
    expect(decide(p, "destructive")).toBe("allow-with-rollback");
  });

  it("Power allows everything except money/secrets", () => {
    const p = getProfile("Power");
    for (const r of ALL_RISKS) {
      if (r === "money" || r === "secrets") {
        expect(decide(p, r)).toBe("ask");
      } else {
        expect(decide(p, r)).toBe("allow");
      }
    }
  });

  it("Autonomous never asks", () => {
    const p = getProfile("Autonomous");
    for (const r of ALL_RISKS) {
      expect(decide(p, r)).not.toBe("ask");
      expect(decide(p, r)).not.toBe("deny");
    }
  });

  it("Autonomous wraps reversible side effects in rollback, lets irreversible run", () => {
    const p = getProfile("Autonomous");
    expect(decide(p, "workspace-write")).toBe("allow-with-rollback");
    expect(decide(p, "shell")).toBe("allow-with-rollback");
    expect(decide(p, "destructive")).toBe("allow-with-rollback");
    // Sent network requests / emails / charges can't be unsent.
    expect(decide(p, "network-write")).toBe("allow");
    expect(decide(p, "external-comms")).toBe("allow");
    expect(decide(p, "money")).toBe("allow");
    expect(decide(p, "secrets")).toBe("allow");
  });

  it("Safe denies the most dangerous classes", () => {
    const p = getProfile("Safe");
    expect(decide(p, "destructive")).toBe("deny");
    expect(decide(p, "money")).toBe("deny");
    expect(decide(p, "secrets")).toBe("deny");
  });

  // Exhaustive matrix: every profile × every risk against the expected table.
  for (const name of PROFILE_NAMES) {
    describe(`${name} matrix`, () => {
      const p = PROFILES[name];
      for (const risk of ALL_RISKS) {
        it(`${name} / ${risk} → ${EXPECTED[name][risk]}`, () => {
          expect(decide(p, risk)).toBe(EXPECTED[name][risk]);
        });
      }
    });
  }

  it("every profile has a decision for every risk", () => {
    for (const name of PROFILE_NAMES) {
      const p = PROFILES[name];
      for (const risk of ALL_RISKS) {
        expect(p.rules[risk]).toBeDefined();
      }
    }
  });

  describe("isProfileName", () => {
    it("accepts known names", () => {
      for (const n of PROFILE_NAMES) expect(isProfileName(n)).toBe(true);
    });
    it("rejects unknown values", () => {
      expect(isProfileName("normal")).toBe(false); // case sensitive
      expect(isProfileName("")).toBe(false);
      expect(isProfileName(null)).toBe(false);
      expect(isProfileName(42)).toBe(false);
    });
  });
});
