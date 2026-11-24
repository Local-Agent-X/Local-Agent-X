// Parallel chunks of a kit project all edit ARCHITECTURE.md and the generated
// codebase map, so the second one to merge always conflicted with the first and
// the build halted with passed chunks unmerged (label-check 2026-11-22). Those
// two conflicts are settled by rule; a conflict in code never is. Real git, a
// real repo, real worktrees.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWorktrees } from "../../agency/worktree-core.js";
import { cleanupWorktree, createNamedWorktree, mergeWorktree } from "../../agency/worktree.js";

// npm is not run here: the relock is stood in for by what it would do to the lockfile.
const npm = vi.hoisted(() => ({ relock: (_dir: string): { ok: true } | { ok: false; why: string } => ({ ok: true }) }));
vi.mock("../../agency/worktree-deps.js", () => ({ relockDependencies: vi.fn(async (dir: string) => npm.relock(dir)) }));

const { createSharedFileMerge, GENERATED_MAP, MAP_SCRIPT, regenerateSharedFiles, relockMergedProject } = await import("./shared-file-merge.js");

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

// Two chunks that each add a package both edit package.json and its lockfile
// where the other did: the second to merge conflicted and was set aside though
// nothing in it was wrong. Adding a package is not a decision, so the manifest
// is merged key by key and the lockfile is written again from it.
describe("merging two chunks that each added a package", () => {
  const manifest = (deps: Record<string, string>): string => `${JSON.stringify({ name: "app", scripts: { build: "tsc" }, dependencies: deps }, null, 2)}\n`;
  const lock = (deps: string[]): string => `${JSON.stringify({ name: "app", lockfileVersion: 3, packages: Object.fromEntries(deps.map((d) => [`node_modules/${d}`, { version: "1.0.0" }])) }, null, 2)}\n`;
  const addPackage = (name: string, version = "^1.0.0") => (wt: string): void => {
    writeFileSync(join(wt, "package.json"), manifest({ [name]: version, react: "^19.0.0" }));
    writeFileSync(join(wt, "package-lock.json"), lock([name, "react"]));
  };

  beforeEach(() => {
    writeFileSync(join(repo, "package.json"), manifest({ react: "^19.0.0" }));
    writeFileSync(join(repo, "package-lock.json"), lock(["react"]));
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "a manifest");
  });

  it("lands both: package.json names both packages in order, and the lockfile waits to be written again", () => {
    buildChunk(4, addPackage("firebase"));
    buildChunk(5, addPackage("expo-camera"));
    const shared = createSharedFileMerge();
    mergeWorktree("sfm-chunk-4", { resolveConflicts: shared.resolver });
    expect(shared.staleLockfiles()).toEqual([]);

    expect(mergeWorktree("sfm-chunk-5", { resolveConflicts: shared.resolver })).toMatchObject({ merged: true });
    expect(read("package.json")).toBe(manifest({ "expo-camera": "^1.0.0", firebase: "^1.0.0", react: "^19.0.0" }));
    // The lockfile is the base's copy, whole: valid JSON for npm to write again from the manifest.
    expect(read("package-lock.json")).toBe(lock(["firebase", "react"]));
    expect(shared.staleLockfiles()).toEqual(["package-lock.json"]);
    expect(g(repo, "status", "--porcelain")).toBe("");
  });

  it("two chunks that want different versions of one package still conflict: that is a decision", () => {
    buildChunk(4, addPackage("firebase", "^11.0.0"));
    buildChunk(5, addPackage("firebase", "^12.0.0"));
    const shared = createSharedFileMerge();
    mergeWorktree("sfm-chunk-4", { resolveConflicts: shared.resolver });

    expect(mergeWorktree("sfm-chunk-5", { resolveConflicts: shared.resolver }).merged).toBe(false);
    expect(read("package.json")).toBe(manifest({ firebase: "^11.0.0", react: "^19.0.0" }));
    expect(shared.staleLockfiles()).toEqual([]);
    expect(shared.mapIsStale()).toBe(false);
    expect(g(repo, "branch", "--list", "autobuild/c5")).toContain("autobuild/c5");
  });

  it("writes the lockfile again in the merged project and commits it", async () => {
    npm.relock = (dir) => { writeFileSync(join(dir, "package-lock.json"), lock(["expo-camera", "firebase", "react"])); return { ok: true }; };
    expect(await relockMergedProject(repo, ["package-lock.json"], "op-1")).toEqual([
      { lockfile: "package-lock.json", ok: true, detail: expect.stringContaining("rewritten and committed") },
    ]);
    expect(read("package-lock.json")).toBe(lock(["expo-camera", "firebase", "react"]));
    expect(g(repo, "log", "-1", "--format=%s")).toBe("relock dependencies after merging parallel chunks");
    expect(g(repo, "status", "--porcelain")).toBe("");
  });

  it("says why when npm could not write the lockfile, and commits nothing", async () => {
    npm.relock = () => ({ ok: false, why: "ENOTFOUND registry.npmjs.org" });
    const head = g(repo, "rev-parse", "HEAD");
    expect(await relockMergedProject(repo, ["package-lock.json"], "op-1")).toEqual([
      { lockfile: "package-lock.json", ok: false, detail: "ENOTFOUND registry.npmjs.org" },
    ]);
    expect(g(repo, "rev-parse", "HEAD")).toBe(head);
  });
});
