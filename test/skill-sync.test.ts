// The skills LAX ships from the owner's ~/.claude/skills name LAX's tools, not
// Claude Code's, and a bundled copy never drifts from what was recorded. The
// upstream comparison needs ~/.claude/skills and runs in check:skill-sync; this
// pins the adaptation and the half that holds on any machine.
import { describe, expect, it } from "vitest";
import { adaptSkill, skillDrift, TOOL_NAMES } from "../scripts/check-skill-sync.mjs";

const skill = (body: string, tools = ["Read", "Grep", "Agent"]) =>
  ["---", "name: blast-radius", "allowed-tools:", ...tools.map((t) => `  - ${t}`), "---", "", body].join("\n");

describe("adaptSkill", () => {
  it("names LAX's tools in the frontmatter and in the adapted phrases", () => {
    const out = adaptSkill("blast-radius", skill('- `Grep` the symbol name, then a **single** Explore agent (breadth "medium").'));
    expect(out).toContain("  - read\n  - grep\n  - agent_spawn\n");
    expect(out).toContain("- `grep` the symbol name");
    expect(out).toContain("`agent_spawn` with the `reviewer` role");
    expect(out).not.toMatch(/Explore|breadth/);
  });

  it("refuses a tool it cannot map, instead of shipping Claude Code's name", () => {
    expect(() => adaptSkill("blast-radius", skill("- `Grep` the symbol name", ["WebFetch"]))).toThrow(/WebFetch/);
  });

  it("refuses a skill whose wording moved, naming the adaptation to update", () => {
    expect(() => adaptSkill("blast-radius", skill("Search for the symbol."))).toThrow(/no longer says .*ADAPTATIONS/);
  });

  it("maps every tool the synced skills' frontmatter uses today", () => {
    expect(Object.keys(TOOL_NAMES)).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent", "AskUserQuestion"]));
  });
});

describe("the bundled copies", () => {
  it("match the hashes they were synced with", () => {
    expect(skillDrift(null)).toEqual([]);
  });
});
