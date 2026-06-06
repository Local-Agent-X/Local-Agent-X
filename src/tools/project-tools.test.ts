/**
 * project_create — brief seeding + onboarding-interview nudge.
 *
 * The interview itself is the agent's normal conversation loop; what the tool
 * owns is (1) seeding the brief from the summary and (2) telling the agent to
 * run the interview and record answers via project_brief_update. Both are
 * verified here.
 *
 * LAX_DATA_DIR must be set before agent-store/paths.ts loads (PROJECTS_FILE is
 * a load-time const), so the store + brief modules are imported dynamically
 * after the env is pointed at a temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-proj-tools-"));
  process.env.LAX_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

describe("project_create — onboarding", () => {
  it("seeds the brief from summary and nudges the interview", async () => {
    const { createProjectTools } = await import("./project-tools.js");
    const { readProjectBrief } = await import("../memory/project-brief.js");
    const { ProjectStore } = await import("../agent-store/index.js");

    const create = createProjectTools().find((t) => t.name === "project_create")!;
    const res = await create.execute({
      name: "Nutrishop McKinney",
      summary: "Supplement retail store. Goal: $1M revenue this year.",
    });

    expect(res.isError).toBeFalsy();
    expect(String(res.content)).toMatch(/interview the user/i);
    expect(String(res.content)).toContain("project_brief_update");
    expect(String(res.content)).toContain("Brief started from your summary");

    const project = ProjectStore.getInstance().findByName("Nutrishop McKinney")!;
    expect(project).toBeTruthy();
    const brief = await readProjectBrief(project.id, join(dataDir, "memory"));
    expect(brief).toContain("Overview");
    expect(brief).toContain("$1M revenue");
    // The seeded root heading is the project name, so later ## sections merge.
    expect(brief).toContain("# Nutrishop McKinney");
  });

  it("still nudges the interview when no summary is given (no brief seeded)", async () => {
    const { createProjectTools } = await import("./project-tools.js");
    const create = createProjectTools().find((t) => t.name === "project_create")!;
    const res = await create.execute({ name: "Bare Project" });

    expect(String(res.content)).toMatch(/interview the user/i);
    expect(String(res.content)).not.toContain("Brief started from your summary");
  });
});
