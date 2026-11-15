/**
 * The git update route, split: prepare builds and gates a candidate in a
 * worktree without touching the live checkout; land fast-forwards the checkout
 * and swaps in the candidate's build output instead of building again; a
 * checkout that moved after prepare is not landed.
 *
 * Real git and the real worktree lifecycle on a temp origin + clone. The four
 * gates are stubbed (the build writes a dist the way build:runtime would), and
 * npm must never run: nothing in these updates changes dependencies.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lax-update-split-"));
process.env.LAX_DATA_DIR = join(root, "data");
mkdirSync(process.env.LAX_DATA_DIR);

vi.mock("../src/self-edit/sandbox-gates.js", async () => {
  const { getWorktreePath } = await import("../src/agency/worktree.js");
  const ok = { ok: true, skipped: false, durationMs: 1, detail: "ok" };
  return {
    SKIPPED_GATE: { ok: false, skipped: true, durationMs: 0, detail: "skipped" },
    BUILD_TIMEOUT_MS: 60_000,
    gateDeps: vi.fn(async () => ({ ok: true, skipped: true, durationMs: 0, detail: "no dependency changes" })),
    gateBuild: vi.fn(async (name: string) => {
      const wt = getWorktreePath(name)!;
      mkdirSync(join(wt, "dist"), { recursive: true });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf-8" }).trim();
      writeFileSync(join(wt, "dist", "index.js"), `// built from ${head}\n`);
      writeFileSync(join(wt, "dist", ".builtref"), head);
      return ok;
    }),
    gateBind: vi.fn(async () => ({ result: ok, proc: null, dataDir: null })),
    gateSmoke: vi.fn(async () => ok),
    killProbe: vi.fn(async () => {}),
    runNpmAt: vi.fn(async () => { throw new Error("npm must not run: no dependency changed"); }),
  };
});

const { prepareGitUpdate, discardGitStaged } = await import("../src/update-git-prepare.js");
const { landGitUpdate } = await import("../src/update-git-land.js");
const gates = await import("../src/self-edit/sandbox-gates.js");

// Git for Windows checks out with CRLF; the content is what is compared.
const text = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
const origin = join(root, "origin.git");
const live = join(root, "live");
const other = join(root, "other");
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "nogit"), GIT_CONFIG_SYSTEM: join(root, "nogit") };
const g = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", env }).trim();

function pushChange(file: string, text: string): string {
  writeFileSync(join(other, file), text);
  g(other, ["add", "-A"]);
  g(other, ["commit", "-m", `change ${file}`]);
  g(other, ["push", "origin", "main"]);
  return g(other, ["rev-parse", "HEAD"]);
}

beforeAll(() => {
  writeFileSync(join(root, "nogit"), "");
  g(root, ["init", "--bare", origin]);
  g(root, ["clone", origin, other]);
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  writeFileSync(join(other, "a.txt"), "one\n");
  g(other, ["add", "-A"]);
  g(other, ["commit", "-m", "base"]);
  g(other, ["push", "origin", "main"]);
  g(root, ["clone", origin, live]);
  mkdirSync(join(live, "dist"));
  writeFileSync(join(live, "dist", "index.js"), "// old build\n");
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("git update: prepare, then land", () => {
  it("prepares without touching the checkout, then lands the prepared build without building again", async () => {
    const before = g(live, ["rev-parse", "HEAD"]);
    const target = pushChange("a.txt", "two\n");

    const prepared = await prepareGitUpdate(live, "tok", "test");
    expect(prepared.ok).toBe(true);
    const staged = prepared.staged!;
    expect(staged).toMatchObject({ route: "git", base: before, target, depsChanged: false, desktopBuilt: false });
    expect(g(live, ["rev-parse", "HEAD"])).toBe(before);
    expect(readFileSync(join(live, "dist", "index.js"), "utf-8")).toBe("// old build\n");
    expect(existsSync(join(staged.worktreePath, "dist", "index.js"))).toBe(true);

    vi.mocked(gates.gateBuild).mockClear();
    const landed = await landGitUpdate(staged, live);
    expect(landed.ok).toBe(true);
    expect(g(live, ["rev-parse", "HEAD"])).toBe(target);
    expect(text(join(live, "a.txt"))).toBe("two\n");
    expect(readFileSync(join(live, "dist", "index.js"), "utf-8")).toBe(`// built from ${target}\n`);
    expect(readFileSync(join(live, "dist", ".builtref"), "utf-8")).toBe(target);
    expect(existsSync(join(live, "dist.next"))).toBe(false);
    expect(gates.gateBuild).not.toHaveBeenCalled();
    expect(gates.runNpmAt).not.toHaveBeenCalled();
  });

  it("does not land on a checkout that moved after prepare, and changes nothing", async () => {
    pushChange("a.txt", "three\n");
    const prepared = await prepareGitUpdate(live, "tok", "test");
    const staged = prepared.staged!;

    writeFileSync(join(live, "local.txt"), "local\n");
    g(live, ["add", "local.txt"]);
    g(live, ["commit", "-m", "local commit after prepare"]);
    const moved = g(live, ["rev-parse", "HEAD"]);

    const landed = await landGitUpdate(staged, live);
    expect(landed).toMatchObject({ ok: false, stale: true });
    expect(g(live, ["rev-parse", "HEAD"])).toBe(moved);
    expect(text(join(live, "a.txt"))).toBe("two\n");

    await discardGitStaged(staged, live);
    expect(existsSync(staged.worktreePath)).toBe(false);
    expect(g(live, ["branch", "--list", staged.branch])).toBe("");
  });

  it("reports an install already on the newest commit as up to date", async () => {
    g(live, ["reset", "--hard", "origin/main"]);
    const r = await prepareGitUpdate(live, "tok", "test");
    expect(r).toMatchObject({ ok: true, detail: "Already up to date." });
    expect(r.staged).toBeUndefined();
  });
});

describe("the click lands what was prepared in the background", () => {
  it("lands a ready candidate through landPreparedUpdate, and empties the slot", async () => {
    const { landPreparedUpdate } = await import("../src/update-pipeline.js");
    const { stageReady, readyUpdate } = await import("../src/update-staging.js");
    g(live, ["reset", "--hard", "origin/main"]);
    const target = pushChange("a.txt", "four\n");
    const prepared = await prepareGitUpdate(live, "tok", "test");
    await stageReady(prepared.staged!, async () => {});

    const landed = await landPreparedUpdate(live);
    expect(landed).toMatchObject({ ok: true });
    expect(g(live, ["rev-parse", "HEAD"])).toBe(target);
    expect(readyUpdate()).toBeNull();
  });

  it("returns null, so the click runs the full path, when the prepared one no longer fits", async () => {
    const { landPreparedUpdate } = await import("../src/update-pipeline.js");
    const { stageReady, readyUpdate } = await import("../src/update-staging.js");
    pushChange("a.txt", "five\n");
    const prepared = await prepareGitUpdate(live, "tok", "test");
    await stageReady(prepared.staged!, async () => {});
    writeFileSync(join(live, "local2.txt"), "x\n");
    g(live, ["add", "local2.txt"]);
    g(live, ["commit", "-m", "moved after prepare"]);

    expect(await landPreparedUpdate(live)).toBeNull();
    expect(readyUpdate()).toBeNull();
    expect(existsSync(prepared.staged!.worktreePath)).toBe(false);
  });
});
