import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRosterStore } from "./project-rosters.js";

// Cross-seam contract for the org-chart wiring that USED to be duplicated in the
// project_create/project_add_agent tool (project-tools.ts) and the /api/projects
// route (routes/agents/projects.ts). Both now call this one seedProjectRosters,
// so this locks the reportsTo behavior: a future edit to the shared function
// can't silently change how EITHER creation path shapes a new project's roster.
//
// Type-only imports above are erased, so the only runtime load of
// project-rosters.ts is the dynamic import in beforeAll — AFTER LAX_DATA_DIR is
// pointed at a temp dir (the store's ROSTERS_FILE is a module-load constant).
let seedProjectRosters: typeof import("./project-rosters.js").seedProjectRosters;
let store: ProjectRosterStore;

let laxDir: string;
let savedLaxDir: string | undefined;

beforeAll(async () => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  laxDir = mkdtempSync(join(tmpdir(), "rosters-"));
  process.env.LAX_DATA_DIR = laxDir;
  const mod = await import("./project-rosters.js");
  seedProjectRosters = mod.seedProjectRosters;
  store = mod.ProjectRosterStore.getInstance();
});

afterAll(() => {
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedLaxDir;
  rmSync(laxDir, { recursive: true, force: true });
});

describe("seedProjectRosters (shared by the project_create tool and the /api/projects route)", () => {
  it("a CEO-led roster auto-wires every non-CEO agent to report to the CEO", async () => {
    const added: Array<[string, string]> = [];
    const projectStore = {
      addAgent: (id: string, agentId: string) => {
        added.push([id, agentId]);
        return true;
      },
    };

    await seedProjectRosters("proj-ceo", ["builtin-ceo", "researcher", "writer"], projectStore);

    expect(store.get("proj-ceo", "builtin-ceo")?.reportsTo).toBeUndefined(); // the CEO reports to no one
    expect(store.get("proj-ceo", "researcher")?.reportsTo).toBe("builtin-ceo");
    expect(store.get("proj-ceo", "writer")?.reportsTo).toBe("builtin-ceo");
    // every agent is also added to the caller-supplied project store
    expect(added).toEqual([
      ["proj-ceo", "builtin-ceo"],
      ["proj-ceo", "researcher"],
      ["proj-ceo", "writer"],
    ]);
  });

  it("a roster with no CEO stays flat (no reportsTo wiring)", async () => {
    await seedProjectRosters("proj-flat", ["alice", "bob"], { addAgent: () => true });
    expect(store.get("proj-flat", "alice")?.reportsTo).toBeUndefined();
    expect(store.get("proj-flat", "bob")?.reportsTo).toBeUndefined();
  });

  it("is a no-op for an empty agent list (no roster rows, no addAgent calls)", async () => {
    const added: string[] = [];
    await seedProjectRosters("proj-empty", [], {
      addAgent: (_id, agentId) => {
        added.push(agentId);
        return true;
      },
    });
    expect(added).toEqual([]);
    expect(store.get("proj-empty", "anyone")).toBeUndefined();
  });
});
