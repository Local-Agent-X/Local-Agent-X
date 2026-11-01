// The skills LAX ships from the owner's ~/.claude/skills name LAX's tools, not
// Claude Code's, and a bundled copy never drifts from what was recorded. The
// upstream comparison needs ~/.claude/skills and runs in check:skill-sync; this
// pins the adaptation and the half that holds on any machine.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTATIONS, adaptSkill, BUNDLED_DIR, companionFiles, skillDrift, syncSkills, TOOL_NAMES } from "../scripts/check-skill-sync.mjs";

const skill = (body: string, tools = ["Read", "Grep", "Agent"], name = "blast-radius") =>
  ["---", `name: ${name}`, "allowed-tools:", ...tools.map((t) => `  - ${t}`), "---", "", body].join("\n");

/** A new-project body holding every phrase the adaptation swaps, so the fixture
 *  follows ADAPTATIONS instead of restating the skill. */
const newProjectBody = () => ADAPTATIONS["new-project"].map(([from]: [string, string]) => from).join("\n\n");

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
    expect(Object.keys(TOOL_NAMES)).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "PowerShell", "Agent", "AskUserQuestion"]));
  });

  it("maps PowerShell to LAX's one shell and lists bash once when a skill allows both", () => {
    const out = adaptSkill("senior-engineer", skill("- `Glob` to find candidates, `Grep` to confirm.", ["Read", "Bash", "PowerShell", "Edit"], "senior-engineer"));
    expect(out).toContain("allowed-tools:\n  - read\n  - bash\n  - edit\n---");
    expect(out).not.toMatch(/PowerShell/i);
  });

  it("tells LAX's agent to call project_kit instead of copying scripts from ~/.claude/skills", () => {
    const out = adaptSkill("new-project", skill(newProjectBody(), ["Bash", "PowerShell"], "new-project"));
    expect(out).toContain("Call\n`project_kit` once");
    expect(out).toContain("| What `project_kit` writes | Purpose |");
    expect(out).toContain("`project_kit` puts the seal test where the test runner finds it.");
    expect(out).not.toMatch(/Claude Code|~\/\.claude|grand-daddy|From this skill/);
  });
});

describe("companion files", () => {
  const scratch: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "skill-sync-")); scratch.push(d); return d; };
  afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** A scratch ~/.claude/skills holding one new-project skill with references/. */
  const upstream = () => {
    const skills = tmp();
    const dir = join(skills, "new-project");
    mkdirSync(join(dir, "references"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skill(newProjectBody(), ["Bash", "PowerShell"], "new-project"));
    writeFileSync(join(dir, "references", "couplings.md"), "# couplings\r\n\r\nkinds\r\n");
    writeFileSync(join(dir, "scripts", "codebase-map.mjs"), "// vendored elsewhere\n");
    return { skills, dir };
  };

  it("are the skill's references/*.md, never its scripts", () => {
    const { dir } = upstream();
    expect(companionFiles(dir)).toEqual(["references/couplings.md"]);
    expect(companionFiles(join(dir, "nowhere"))).toEqual([]);
  });

  it("are copied LF-folded beside SKILL.md with their hashes recorded, and then show no drift", () => {
    const { skills } = upstream();
    const bundled = tmp();
    expect(syncSkills(skills, bundled, ["new-project"])).toBe(1);
    expect(readFileSync(join(bundled, "new-project", "references", "couplings.md"), "utf-8")).toBe("# couplings\n\nkinds\n");
    const manifest = JSON.parse(readFileSync(join(bundled, "new-project", "UPSTREAM.json"), "utf-8"));
    expect(Object.keys(manifest.files)).toEqual(["references/couplings.md"]);
    expect(manifest.files["references/couplings.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(skillDrift(skills, bundled, ["new-project"])).toEqual([]);
    expect(skillDrift(null, bundled, ["new-project"])).toEqual([]);
  });

  it("drift both ways: a hand edit here, a change upstream, a file upstream that is not bundled, one bundled that upstream dropped", () => {
    const { skills, dir } = upstream();
    const bundled = tmp();
    syncSkills(skills, bundled, ["new-project"]);

    writeFileSync(join(bundled, "new-project", "references", "couplings.md"), "# couplings\n\nedited here\n");
    expect(skillDrift(null, bundled, ["new-project"])).toEqual([
      "new-project/references/couplings.md does not match the hash in its UPSTREAM.json (hand-edited?)",
    ]);
    syncSkills(skills, bundled, ["new-project"]);

    writeFileSync(join(dir, "references", "couplings.md"), "# couplings\n\nmoved on\n");
    expect(skillDrift(skills, bundled, ["new-project"])).toEqual([`new-project/references/couplings.md differs from ${join(dir, "references", "couplings.md")}`]);
    expect(skillDrift(null, bundled, ["new-project"])).toEqual([]);
    syncSkills(skills, bundled, ["new-project"]);

    writeFileSync(join(dir, "references", "retrofit.md"), "# retrofit\n");
    expect(skillDrift(skills, bundled, ["new-project"])).toEqual([`new-project/references/retrofit.md is not bundled (${dir} has it)`]);

    rmSync(join(dir, "references", "couplings.md"));
    expect(skillDrift(skills, bundled, ["new-project"])).toContain(`new-project/references/couplings.md is bundled but no longer in ${dir}`);
  });
});

describe("the bundled copies", () => {
  it("match the hashes they were synced with", () => {
    expect(skillDrift(null)).toEqual([]);
  });

  it("new-project names project_kit, its references travel with it, and nothing points at Claude Code", () => {
    const dir = join(BUNDLED_DIR, "new-project");
    const text = readFileSync(join(dir, "SKILL.md"), "utf-8");
    expect(text).toContain("`project_kit`");
    expect(text).not.toMatch(/Claude Code|~\/\.claude\/skills|grand-daddy|PowerShell/);
    expect(text).toContain("  - bash\n");
    expect(text).not.toContain("  - bash\n  - bash\n");
    const manifest = JSON.parse(readFileSync(join(dir, "UPSTREAM.json"), "utf-8"));
    expect(Object.keys(manifest.files)).toEqual(["references/couplings.md", "references/registry-pattern.md", "references/retrofit.md", "references/templates.md"]);
    for (const file of text.matchAll(/`(references\/[a-z-]+\.md)`/g)) expect(manifest.files).toHaveProperty(file[1]);
  });
});
