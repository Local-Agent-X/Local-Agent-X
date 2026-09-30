import { describe, expect, it } from "vitest";
import { CAPABILITY_CLASS_MEMBERS } from "../tool-registry.js";
import { getSessionPolicy, setSessionPolicy } from "./policy.js";

// A preset blocks capability CLASSES from the registry, so every synonym of a
// blocked tool is blocked with it. The old hand-written lists blocked `write`
// and `edit` but not edit_lines / multi_edit / bulk_replace / delete_file, and
// `bash` but not process_start (found 2026-07-29).
describe("session policy presets block capability classes, not tool names", () => {
  it("read-only blocks every shell, egress and workspace-write tool", () => {
    const policy = setSessionPolicy("s-read-only", "read-only");
    for (const cls of ["shell", "egress", "workspace-write"] as const) {
      for (const tool of CAPABILITY_CLASS_MEMBERS[cls]) {
        expect(policy.blockedTools.has(tool), `${tool} (${cls})`).toBe(true);
      }
    }
    expect(policy.blockedTools.has("read")).toBe(false);
    expect(CAPABILITY_CLASS_MEMBERS["workspace-write"]).toEqual(expect.arrayContaining(["edit_lines", "delete_file"]));
  });

  it("high-security blocks shell and egress but leaves writes", () => {
    const policy = setSessionPolicy("s-high", "high-security");
    for (const tool of [...CAPABILITY_CLASS_MEMBERS.shell, ...CAPABILITY_CLASS_MEMBERS.egress]) {
      expect(policy.blockedTools.has(tool), tool).toBe(true);
    }
    expect(policy.blockedTools.has("write")).toBe(false);
  });

  it("default and dev-mode block nothing, and a session's set is its own copy", () => {
    expect(getSessionPolicy("nobody").blockedTools.size).toBe(0);
    const dev = setSessionPolicy("s-dev", "dev-mode");
    dev.blockedTools.add("bash");
    expect(setSessionPolicy("s-dev-2", "dev-mode").blockedTools.size).toBe(0);
  });
});
