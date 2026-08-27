// Risk-tier regression tests for the app_* fragment of the unified policy table.
//
// The bug: app_permissions was declared risk:"safe" while EVERY one of its
// actions mutates the app registry (grant / revoke / suspend / activate /
// archive — src/tools/app-tools/lifecycle.ts). Because committing-tool-check.ts
// and tool-mutation-check.ts are pure projections of this table's `risk`, a real
// permission grant read as zero committed work: isCommittingTool() answered
// false, so the grant never suppressed failover and a replayed turn could
// double-grant, and the loop detectors saw no progress.
//
// These tests pin the corrected tier and the three downstream projections, so a
// revert to "safe" — or any future LOOSENING of an app mutator — fails here.

import { describe, expect, it } from "vitest";

import { TOOLS, type ToolRisk } from "../tool-registry.js";
import { isCommittingTool } from "../committing-tool-check.js";
import { isMutationTool, isProgressTool } from "../tool-mutation-check.js";
import { classifyToolRisk } from "../autonomy/risk.js";
import { decide, getProfile, PROFILE_NAMES } from "../autonomy/profiles.js";
import { appPermissions } from "../tools/app-tools/lifecycle.js";

describe("guards on the premise itself", () => {
  it("app_permissions requires an action and every declared one is a mutation", () => {
    // Free-form string, not an enum — the table cannot lean on a read-only
    // action existing. If a reader action is ever added here, the tier needs to
    // become arg-aware rather than staying a flat mutator tier.
    expect(appPermissions.parameters.required).toContain("action");
    const actions = String(
      (appPermissions.parameters.properties as Record<string, { description?: string }>).action
        ?.description ?? "",
    );
    for (const mutating of ["grant", "revoke", "suspend", "activate", "archive"]) {
      expect(actions).toContain(mutating);
    }
  });
});

describe("app_permissions is tiered as the mutator it is", () => {
  it("is workspace-write, matching its app_action / app_update siblings", () => {
    expect(TOOLS.app_permissions.risk).toBe<ToolRisk>("workspace-write");
    expect(TOOLS.app_permissions.risk).toBe(TOOLS.app_action.risk);
    expect(TOOLS.app_permissions.risk).toBe(TOOLS.app_update.risk);
    expect(classifyToolRisk("app_permissions")).toBe<ToolRisk>("workspace-write");
  });

  it("reads as committing, so a grant suppresses failover instead of scoring as no work", () => {
    expect(isCommittingTool("app_permissions")).toBe(true);
  });

  it("counts as a mutation and as progress for the loop detectors", () => {
    expect(isMutationTool("app_permissions")).toBe(true);
    expect(isProgressTool("app_permissions")).toBe(true);
  });

  it("is not over-tiered to destructive — every action is reversible", () => {
    // grant↔revoke and suspend↔activate↔archive all undo; nothing is deleted,
    // so it must not inherit app_delete's irreversibility floor (which would
    // force a confirm under every profile via destructiveOperationReason).
    expect(TOOLS.app_permissions.risk).not.toBe<ToolRisk>("destructive");
    expect(TOOLS.app_delete.risk).toBe<ToolRisk>("destructive");
  });
});

describe("the tier change tightens and never loosens", () => {
  // Recorded blast radius: the ONLY profile whose decision changes to a prompt
  // is Safe (safe:"allow" → workspace-write:"ask"). Autonomous gains rollback
  // wrapping. The shipped default (Power) is unaffected.
  const expected: Record<string, string> = {
    Safe: "ask",
    Normal: "allow",
    Developer: "allow",
    Power: "allow",
    Autonomous: "allow-with-rollback",
  };

  for (const name of PROFILE_NAMES) {
    it(`${name} decides app_permissions → ${expected[name]}`, () => {
      expect(decide(getProfile(name), classifyToolRisk("app_permissions"))).toBe(expected[name]);
    });
  }

  it("never decides app_permissions more permissively than app_action", () => {
    for (const name of PROFILE_NAMES) {
      const profile = getProfile(name);
      expect(decide(profile, classifyToolRisk("app_permissions"))).toBe(
        decide(profile, classifyToolRisk("app_action")),
      );
    }
  });
});

describe("the app_* readers are untouched", () => {
  // Proves this was a targeted re-tier of one mis-tiered mutator, not a blanket
  // bump of the family — the readers keep their genuinely read-only tier.
  it("keeps app_read / app_query / app_list at safe", () => {
    expect(TOOLS.app_read.risk).toBe<ToolRisk>("safe");
    expect(TOOLS.app_query.risk).toBe<ToolRisk>("safe");
    expect(TOOLS.app_list.risk).toBe<ToolRisk>("safe");
    expect(isCommittingTool("app_read")).toBe(false);
  });
});
