import { describe, it, expect } from "vitest";
import { TOOL_POLICIES } from "../src/tool-policy/tool-policies.js";
import { CAPABILITY_CLASS_MEMBERS, callPaths } from "../src/tool-registry.js";
import { WORKTREE_REQUIRED_TOOLS } from "../src/security/layer/index.js";
import { createVerifyGateState, noteVerifyEvidence } from "../src/agent-guards/verify-gate.js";
import { collectRuntimeToolNames } from "../src/tools/runtime-tool-names.js";
import { BUILD_MUTATION_TOOLS } from "../src/ops/tools/delegated-toolset.js";

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

// A call of the tool that writes `path`: a tool whose row reads the action
// off an argument (ari_file: action "write") gets that action, so its
// action-gated path specs count as the write they are.
function writeCall(name: string, path: string): Record<string, unknown> {
  const spec = TOOL_POLICIES[name].ariAction;
  return typeof spec === "object" ? { path, [spec.arg]: spec.writes[0] } : { path };
}

// Every tool the runtime registers, core and plugin alike.
const runtimeTools = await collectRuntimeToolNames();

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

  it("every workspace-write file tool's edit of a source file reaches the verify (build-nudge) gate", () => {
    // The gate reads what a call wrote off its declared path specs (callPaths),
    // so a tool joins by its policy row — no list to forget it in.
    const missing = writeFamily.filter((t) => {
      const state = createVerifyGateState();
      noteVerifyEvidence([{ tool: t, writes: callPaths(t, writeCall(t, "src/a.ts")).writes }], state);
      return !state.editedSource;
    });
    expect(missing, `source edits via these tools never nudge a build: ${missing.join(", ")}`).toEqual([]);
  });

  // The build worker's belt grants no authority of its own: every tool it
  // adds must be one the delegated worktree gate inspects, or a worker would
  // mutate outside its work root under that spelling.
  it("every build-worker mutation tool requires worktree isolation for delegated agents", () => {
    const missing = BUILD_MUTATION_TOOLS.filter((t) => !WORKTREE_REQUIRED_TOOLS.has(t));
    expect(missing, `a build worker could mutate ungated via: ${missing.join(", ")}`).toEqual([]);
    expect(BUILD_MUTATION_TOOLS.filter((t) => !runtimeTools.has(t))).toEqual([]);
  });

  it("every workspace-write file tool is actually registered at runtime", () => {
    const missing = writeFamily.filter((t) => !runtimeTools.has(t));
    expect(missing, `policy entry exists but tool is not in the registry: ${missing.join(", ")}`).toEqual([]);
  });
});
