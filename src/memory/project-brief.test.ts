/**
 * Project brief — substrate tests.
 *
 * Covers the two things that make this more than a copy of the personality
 * files: the per-project lock (concurrent multi-writer edits must merge, not
 * clobber) and heading-merge evolution (a repeated section replaces its prior
 * version while net-new sections are kept).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProjectBrief,
  updateProjectBrief,
  projectBriefPath,
  _resetProjectBriefLocksForTest,
} from "./project-brief.js";
import { createInternalMemoryContext } from "./promotion-gate.js";

let memDir: string;
const PID = "proj-test-abc123";
const approved = (content: string) => createInternalMemoryContext(content, "memory:project-brief", "test");

beforeEach(() => {
  memDir = join(mkdtempSync(join(tmpdir(), "lax-brief-")), "memory");
  _resetProjectBriefLocksForTest();
});

afterEach(() => {
  try { rmSync(memDir, { recursive: true, force: true }); } catch {}
});

describe("project brief — read/update", () => {
  it("returns null when no brief exists yet", async () => {
    expect(await readProjectBrief(PID, memDir)).toBeNull();
  });

  it("creates the brief on first update and reads it back", async () => {
    await updateProjectBrief(PID, "# Initech\n\n- Goal: $1M revenue", { memDir, title: "Initech", promotion: approved("# Initech\n\n- Goal: $1M revenue") });
    const brief = await readProjectBrief(PID, memDir);
    expect(brief).toContain("Initech");
    expect(brief).toContain("Goal: $1M revenue");
  });

  it("merges a net-new section while keeping the old one", async () => {
    await updateProjectBrief(PID, "# Initech\n\n- Goal: $1M revenue", { memDir, title: "Initech", promotion: approved("# Initech\n\n- Goal: $1M revenue") });
    await updateProjectBrief(PID, "## Competitors\n- GNC opened nearby", { memDir, title: "Initech", promotion: approved("## Competitors\n- GNC opened nearby") });
    const brief = await readProjectBrief(PID, memDir);
    expect(brief).toContain("Goal: $1M revenue");
    expect(brief).toContain("GNC opened nearby");
  });

  it("a repeated heading replaces its prior version (current state wins)", async () => {
    await updateProjectBrief(PID, "## Status\n- revenue is $200k", { memDir, title: "Initech", promotion: approved("## Status\n- revenue is $200k") });
    await updateProjectBrief(PID, "## Status\n- revenue is $350k", { memDir, title: "Initech", promotion: approved("## Status\n- revenue is $350k") });
    const brief = await readProjectBrief(PID, memDir);
    expect(brief).toContain("$350k");
    expect(brief).not.toContain("$200k");
  });

  it("rejects an invalid project id", async () => {
    expect(projectBriefPath("../escape", memDir)).toBeNull();
    await expect(updateProjectBrief("../escape", "x", { memDir })).rejects.toThrow();
  });

  it("rejects empty content", async () => {
    await expect(updateProjectBrief(PID, "   ", { memDir })).rejects.toThrow();
  });
});

describe("project brief — concurrent multi-writer", () => {
  it("does not lose updates when two agents write at once", async () => {
    // Fire concurrent updates with distinct headings. Without the per-project
    // lock these read-modify-write each other and one section is lost; with it
    // they serialize and both survive the merge.
    await Promise.all([
      updateProjectBrief(PID, "## Marketing\n- launched email campaign", { memDir, title: "Initech", promotion: approved("## Marketing\n- launched email campaign") }),
      updateProjectBrief(PID, "## Social\n- posted 3x this week", { memDir, title: "Initech", promotion: approved("## Social\n- posted 3x this week") }),
      updateProjectBrief(PID, "## Inventory\n- restocked protein", { memDir, title: "Initech", promotion: approved("## Inventory\n- restocked protein") }),
    ]);

    const brief = await readProjectBrief(PID, memDir);
    expect(brief).toContain("launched email campaign");
    expect(brief).toContain("posted 3x this week");
    expect(brief).toContain("restocked protein");
  });
});
