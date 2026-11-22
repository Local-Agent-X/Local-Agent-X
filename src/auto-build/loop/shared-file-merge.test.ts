// Parallel chunks of a kit project all edit ARCHITECTURE.md and the generated
// codebase map, so the second one to merge always conflicted with the first and
// the build halted with passed chunks unmerged (label-check 2026-11-22). Those
// two conflicts are settled by rule; a conflict in code never is. Real git, a
// real repo, real worktrees.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWorktrees } from "../../agency/worktree-core.js";
import { cleanupWorktree, createNamedWorktree, mergeWorktree } from "../../agency/worktree.js";
import { createSharedFileMerge, GENERATED_MAP, MAP_SCRIPT, regenerateSharedFiles } from "./shared-file-merge.js";

const NAMES = ["sfm-chunk-4", "sfm-chunk-5"];
let repo: string;
const g = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const read = (rel: string): string => readFileSync(join(repo, rel), "utf-8").replace(/\r\n/g, "\n");

const ARCH = ["# Architecture", "", "| Module | Owns |", "|---|---|", "| `src/app` | the shell |", ""].join("\n");

beforeEach(() => {
  process.env.LAX_SANDBOX = "host";
  repo = mkdtempSync(join(tmpdir(), "lax-shared-merge-"));
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  g(repo, "config", "core.autocrlf", "false");
  mkdirSync(join(repo, "docs"));
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "ARCHITECTURE.md"), ARCH);
  writeFileSync(join(repo, GENERATED_MAP), "# Codebase map (generated)\n\nmodules: app\n");
  writeFileSync(join(repo, MAP_SCRIPT), "// the kit's map script\n");
  writeFileSync(join(repo, "src", "shared.ts"), "export const limit = 1;\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
});

afterEach(() => {
  delete process.env.LAX_SANDBOX;
  for (const name of NAMES) {
    try { cleanupWorktree(name); } catch { /* already merged or cleaned */ }
    activeWorktrees.delete(name);
  }
  rmSync(repo, { recursive: true, force: true });
});

/** A chunk's work in its own worktree: its module, its ARCHITECTURE.md row, its regenerated map. */
function buildChunk(n: number, extra: (wt: string) => void = () => {}): string {
  const wt = createNamedWorktree(`sfm-chunk-${n}`, `autobuild/c${n}`, repo, `run:${n}`);
  if (!wt) throw new Error("no worktree");
  writeFileSync(join(wt.path, "src", `chunk${n}.ts`), `export const chunk = ${n};\n`);
  writeFileSync(join(wt.path, "ARCHITECTURE.md"), `${ARCH.trimEnd()}\n| \`src/chunk${n}\` | chunk ${n}'s part |\n`);
  writeFileSync(join(wt.path, GENERATED_MAP), `# Codebase map (generated)\n\nmodules: app, chunk${n}\n`);
  extra(wt.path);
  return wt.path;
}

describe("merging two chunks that both edited the shared project files", () => {
  it("lands both: ARCHITECTURE.md keeps both rows, and the map is marked for regenerating", () => {
    buildChunk(4);
    buildChunk(5);
    const shared = createSharedFileMerge();

    expect(mergeWorktree("sfm-chunk-4", { resolveConflicts: shared.resolver })).toMatchObject({ merged: true });
    expect(shared.mapIsStale()).toBe(false); // the first merge conflicts with nothing
    const second = mergeWorktree("sfm-chunk-5", { resolveConflicts: shared.resolver });

    expect(second).toMatchObject({ merged: true });
    expect(existsSync(join(repo, "src", "chunk4.ts")) && existsSync(join(repo, "src", "chunk5.ts"))).toBe(true);
    const arch = read("ARCHITECTURE.md");
    expect(arch).toContain("| `src/chunk4` | chunk 4's part |");
    expect(arch).toContain("| `src/chunk5` | chunk 5's part |");
    expect(arch).not.toMatch(/^[<=>]{7}/m);
    expect(arch.match(/\| `src\/app` \| the shell \|/g)).toHaveLength(1);
    // The map is the base's copy, whole, waiting to be generated from the merged tree.
    expect(read(GENERATED_MAP)).toBe("# Codebase map (generated)\n\nmodules: app, chunk4\n");
    expect(shared.mapIsStale()).toBe(true);
    shared.mapRegenerated();
    expect(shared.mapIsStale()).toBe(false);
    expect(g(repo, "status", "--porcelain")).toBe("");
  });

  it("without the rule the second merge is refused, the base is as the first left it, and the branch is kept", () => {
    buildChunk(4);
    buildChunk(5);
    mergeWorktree("sfm-chunk-4");
    const second = mergeWorktree("sfm-chunk-5");

    expect(second.merged).toBe(false);
    expect(second.error).toContain("autobuild/c5");
    expect(existsSync(join(repo, "src", "chunk5.ts"))).toBe(false);
    expect(read("ARCHITECTURE.md")).not.toContain("chunk5");
    expect(g(repo, "branch", "--list", "autobuild/c5")).toContain("autobuild/c5");
  });

  it("never settles a conflict in code, even alongside the shared files", () => {
    buildChunk(4, (wt) => writeFileSync(join(wt, "src", "shared.ts"), "export const limit = 4;\n"));
    buildChunk(5, (wt) => writeFileSync(join(wt, "src", "shared.ts"), "export const limit = 5;\n"));
    const shared = createSharedFileMerge();
    mergeWorktree("sfm-chunk-4", { resolveConflicts: shared.resolver });
    const second = mergeWorktree("sfm-chunk-5", { resolveConflicts: shared.resolver });

    expect(second.merged).toBe(false);
    expect(read("src/shared.ts")).toBe("export const limit = 4;\n");
    expect(read("ARCHITECTURE.md")).not.toContain("chunk5");
    expect(shared.mapIsStale()).toBe(false); // all or nothing: nothing was taken
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(g(repo, "branch", "--list", "autobuild/c5")).toContain("autobuild/c5");
  });

  it("generates the map again from the merged project and commits it, once", async () => {
    writeFileSync(
      join(repo, MAP_SCRIPT),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("docs/codebase-map.md", "# Codebase map (generated)\\n\\nmodules: regenerated\\n");\n',
    );
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "a map script that writes");

    const first = await regenerateSharedFiles(repo);
    expect(first).toMatchObject({ ok: true });
    expect(first.detail).toContain("regenerated and committed");
    expect(read(GENERATED_MAP)).toContain("modules: regenerated");
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(g(repo, "log", "-1", "--format=%s")).toBe("regenerate the codebase map after merging parallel chunks");
    // Already current: nothing to commit.
    expect(await regenerateSharedFiles(repo)).toEqual({ ok: true, detail: "already current" });
  });

  it("says so when the map script fails, and leaves the project as it was", async () => {
    writeFileSync(join(repo, MAP_SCRIPT), "process.exit(3);\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "a map script that fails");

    expect(await regenerateSharedFiles(repo)).toEqual({ ok: false, detail: "the map script exited 3" });
    expect(g(repo, "status", "--porcelain")).toBe("");
  });

  it("leaves a map conflict alone in a project that has no map script to generate it again", () => {
    rmSync(join(repo, MAP_SCRIPT));
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "no kit");
    buildChunk(4);
    buildChunk(5);
    const shared = createSharedFileMerge();
    mergeWorktree("sfm-chunk-4", { resolveConflicts: shared.resolver });

    expect(mergeWorktree("sfm-chunk-5", { resolveConflicts: shared.resolver }).merged).toBe(false);
    expect(shared.mapIsStale()).toBe(false);
  });
});
