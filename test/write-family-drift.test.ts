import { describe, it, expect } from "vitest";
import { TOOL_POLICIES } from "../src/tool-policy/tool-policies.js";
import { CAPABILITY_CLASS_MEMBERS } from "../src/tool-registry.js";
import { WORKTREE_REQUIRED_TOOLS } from "../src/security/types.js";
import { EDIT_TOOLS } from "../src/agent-guards/verify-gate.js";
import { allTools } from "../src/tools/registry-build.js";

// A new edit-family tool must join every capability set that gates the write
// class BY NAME, or the class fails open under the new spelling: a
// workspace-write ban that blocks `edit` but not the newcomer, a delegated
// agent writing without a worktree, a build-verify gate that never fires.
// bulk_replace shipped registered in the policy table but absent from these
// sets (2026-07-07) — this test makes that gap a test failure instead of a
// silent hole. Membership is derived from the policy table (kernel "file" +
// risk "workspace-write"), the same source deriveTools() projects, so the
// assertion can't drift from registration itself.
const writeFamily = Object.entries(TOOL_POLICIES)
  .filter(([, e]) => e.kernel === "file" && e.risk === "workspace-write")
  .map(([name]) => name);

describe("write-family capability-set drift", () => {
  it("policy table actually yields a write family (guards the filter itself)", () => {
    expect(writeFamily).toContain("edit");
    expect(writeFamily).toContain("bulk_replace");
  });

  it("every workspace-write file tool is in CAPABILITY_CLASS_MEMBERS['workspace-write']", () => {
    const members = new Set(CAPABILITY_CLASS_MEMBERS["workspace-write"]);
    const missing = writeFamily.filter((t) => !members.has(t));
    expect(missing, `write-class ban fails open for: ${missing.join(", ")}`).toEqual([]);
  });

  it("every workspace-write file tool requires worktree isolation for delegated agents", () => {
    const missing = writeFamily.filter((t) => !WORKTREE_REQUIRED_TOOLS.has(t));
    expect(missing, `delegated agents can write without a worktree via: ${missing.join(", ")}`).toEqual([]);
  });

  it("every workspace-write file tool triggers the verify (build-nudge) gate", () => {
    const missing = writeFamily.filter((t) => !EDIT_TOOLS.has(t));
    expect(missing, `source edits via these tools never nudge a build: ${missing.join(", ")}`).toEqual([]);
  });

  it("every workspace-write file tool is actually registered in allTools", () => {
    const registered = new Set(allTools.map((t) => t.name));
    const missing = writeFamily.filter((t) => !registered.has(t));
    expect(missing, `policy entry exists but tool is not in the registry: ${missing.join(", ")}`).toEqual([]);
  });
});
