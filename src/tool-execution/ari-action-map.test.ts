import { describe, it, expect } from "vitest";
import { TOOLS, GATED_KERNEL_CLASSES } from "../tool-registry.js";
import { ARI_ACTION_MAP } from "./enforce-policy.js";

// The kernel firewall validates `action` against each tool class's schema —
// http accepts only HTTP verbs, file accepts read/write, etc. A kernel-gated
// tool with no ARI_ACTION_MAP entry falls through to "exec", which only the
// shell class accepts: every call then throws inside firewall.execute and
// ariRequired mode turns it into a hard block. That is the third
// hand-maintained per-tool table a new tool must touch (policy entry,
// capability class, action map) — and the third to ship a gap: image_search
// landed mapped in policy but not here, and every call blocked as
// "ARI error (ariRequired mode)" (2026-06-10).
const ACTIONS_BY_CLASS: Record<string, ReadonlySet<string>> = {
  http: new Set(["get", "head", "options", "post", "put", "patch", "delete"]),
  file: new Set(["read", "write"]),
  database: new Set(["query", "exec", "mutate"]),
  retrieval: new Set(["search"]),
};

describe("ARI_ACTION_MAP coverage — every kernel-gated tool maps to a schema-valid action", () => {
  const gated = Object.entries(TOOLS).filter(([, e]) => GATED_KERNEL_CLASSES.has(e.kernel));

  it("no non-shell gated tool falls through to the 'exec' default", () => {
    const missing = gated
      .filter(([, e]) => e.kernel !== "shell" && e.kernel !== "secret-vault")
      .filter(([name]) => !ARI_ACTION_MAP[name])
      .map(([name, e]) => `${name} (${e.kernel})`);
    expect(
      missing,
      `kernel-gated tools with no ARI_ACTION_MAP entry — every call will throw ` +
      `"Unknown action 'exec'" and block in ariRequired mode: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every mapped action is valid for its tool's kernel class", () => {
    const bad = gated
      .filter(([name, e]) => ARI_ACTION_MAP[name] && ACTIONS_BY_CLASS[e.kernel])
      .filter(([name, e]) => !ACTIONS_BY_CLASS[e.kernel].has(ARI_ACTION_MAP[name]))
      .map(([name, e]) => `${name}: "${ARI_ACTION_MAP[name]}" not valid for class "${e.kernel}"`);
    expect(bad).toEqual([]);
  });
});
