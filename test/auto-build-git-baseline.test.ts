/**
 * ensureGitBaseline — the build loop's rollback machinery needs a git repo
 * with a HEAD, and nothing upstream guarantees one.
 *
 * Regression (Jul 2026 food-truck-tracker run): run_build_plan halted before
 * chunk 1 with "git rev-parse HEAD failed: not a git repository" because
 * finalize_app_build materializes plain files and no step ever ran git init.
 * The loop now establishes its own baseline instead of assuming it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

// git runs through the caged-spawn seam. The sandbox facade is modelled so the
// wrap is observable and no test reaches a real cage; the wrap passes the
// program through, so every git below is real.
const seam = vi.hoisted(() => ({
  proofPending: false,
  mode: "host" as "host" | "guarded",
  wrapped: [] as Array<{ file: string; args: string[]; env: Record<string, string> }>,
}));
vi.mock("../src/sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox/index.js")>();
  return {
    ...actual,
    awaitSandboxProof: async () => {},
    getSandboxMode: () => seam.mode,
    ensureWinCageGrants: async () => {},
    wrapSpawnForSandbox: (file: string, args: string[], env: Record<string, string>) => {
      if (seam.proofPending) throw new actual.SandboxProofPendingError();
      seam.wrapped.push({ file, args, env });
      return { cmd: file, args };
    },
  };
});
vi.mock("../src/tools/shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));

import { ensureGitBaseline, getHeadSha, gitAdd, gitCommit, gitDiffPath, gitFailText } from "../src/auto-build/git-helpers.js";
import { makeInitial, markHalted } from "../src/auto-build/orchestrator/state.js";
import { SANDBOX_PROOF_PENDING_RETRY } from "../src/sandbox/index.js";

beforeEach(() => {
  seam.proofPending = false;
  seam.mode = "host";
  seam.wrapped = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("ensureGitBaseline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-build-baseline-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it("inits a repo and commits everything when the dir is not a repo", async () => {
    writeFileSync(join(dir, "spec.md"), "# spec");
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(true);
    expect(b.committed).toBe(true);
    expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
    // Working tree is clean — spec.md is part of the baseline.
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
    expect(await getHeadSha(dir)).toBe(b.sha);
  });

  it("commits a baseline in a fresh repo that has no HEAD yet", async () => {
    git(dir, "init");
    writeFileSync(join(dir, "a.txt"), "a");
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(false);
    expect(b.committed).toBe(true);
    expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is a no-op when the repo already has a HEAD", async () => {
    git(dir, "init");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "seed");
    const before = await getHeadSha(dir);
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(false);
    expect(b.committed).toBe(false);
    expect(b.sha).toBe(before);
  });

  it("baselines an empty dir (allow-empty commit)", async () => {
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(true);
    expect(b.committed).toBe(true);
    expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

// Regression (2026-07-02 chunk-1 commit): no ignore rules → `git add .`
// swept node_modules/ + .next/ and hit the 30s timeout, and the halt reason
// was 3.6MB of CRLF warnings. The baseline must install ignore rules and
// git failures must read as messages.
describe("baseline ignore rules + failure text", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-build-excludes-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it("fresh init writes a starter .gitignore and loop excludes", async () => {
    await ensureGitBaseline(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".lax-build-run.json");
    const ex = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
    expect(ex).toContain("# lax-auto-build excludes");
  });

  it("pre-existing repo without .gitignore still gets info/exclude rules (idempotent)", async () => {
    git(dir, "init");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "seed");
    await ensureGitBaseline(dir);
    await ensureGitBaseline(dir); // second run must not duplicate the block
    const ex = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
    expect([...ex.matchAll(/# lax-auto-build excludes/g)]).toHaveLength(1);
    // No starter .gitignore imposed on an existing repo.
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    // And the excludes actually bite: junk created later stays untracked-invisible.
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(dir, ".lax-build-run.json"), "{}");
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
  });

  it("gitFailText: timeout reads as timeout, warnings are filtered and capped", () => {
    expect(gitFailText("git add .", { exitCode: null, stdout: "", stderr: "warning: spam\n".repeat(50), timedOut: true }, 180000))
      .toContain("timed out after 180s");
    const spam = Array.from({ length: 5000 }, (_, i) => `warning: in the working copy of 'f${i}.js', LF will be replaced`).join("\n");
    const msg = gitFailText("git add .", { exitCode: 1, stdout: "", stderr: spam + "\nfatal: real problem", timedOut: false });
    expect(msg).toContain("fatal: real problem");
    expect(msg).not.toContain("warning:");
    expect(msg.length).toBeLessThan(2000);
  });
});

describe("git runs in the shell cage, hardened against the agent's own repo", () => {
  const CREDENTIAL = "GIT_HELPERS_TEST_API_KEY";
  const HARDENED = [
    "-c", "gc.auto=0", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never",
    "-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgSign=false", "--no-pager",
  ];
  const IDENTITY_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "GIT_CONFIG_NOSYSTEM"];
  const savedEnv: Record<string, string | undefined> = {};
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-build-cage-"));
    process.env[CREDENTIAL] = "sk-live-0123456789abcdef";
    for (const key of IDENTITY_ENV) savedEnv[key] = process.env[key];
  });
  afterEach(() => {
    delete process.env[CREDENTIAL];
    for (const key of IDENTITY_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const expectGitProgram = (file: string): void => {
    if (process.platform === "win32") expect(file).toMatch(/^[a-z]:\\.*\\git\.exe$/i);
    else expect(file).toBe("git");
  };

  it("every op is git with no shell, hardened, on the scrubbed env", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const { sha } = await ensureGitBaseline(dir);
    await gitDiffPath(dir, sha, ".");

    expect(seam.wrapped.length).toBeGreaterThan(4);
    for (const { file, args, env } of seam.wrapped) {
      expectGitProgram(file);
      expect(args.slice(0, HARDENED.length)).toEqual(HARDENED);
      expect(args).not.toContain("safe.directory=*");
      expect(env[CREDENTIAL]).toBeUndefined();
    }
    expect(seam.wrapped.at(-1)!.args.slice(HARDENED.length)).toEqual(["diff", "--no-color", "--no-ext-diff", "--no-textconv", sha, "--", "."]);
  });

  it("the agent's hooks never run, in .git/hooks or wherever its config points", async () => {
    git(dir, "init");
    mkdirSync(join(dir, ".githooks"));
    const hook = (marker: string): string => `#!/bin/sh\necho ran > "${join(dir, marker).replace(/\\/g, "/")}"\n`;
    for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      writeFileSync(join(dir, ".git", "hooks", name), hook(`${name}.default-ran`), { mode: 0o755 });
      writeFileSync(join(dir, ".githooks", name), hook(`${name}.configured-ran`), { mode: 0o755 });
    }
    const markers = (): string[] => readdirSync(dir).filter((f) => f.endsWith("-ran"));

    writeFileSync(join(dir, "a.txt"), "a");
    await ensureGitBaseline(dir);
    git(dir, "config", "core.hooksPath", ".githooks");
    writeFileSync(join(dir, "b.txt"), "b");
    await gitAdd(dir, "b.txt");
    expect((await gitCommit(dir, "chunk 1: b")).committed).toBe(true);
    expect(markers()).toEqual([]);

    // The hooks are live: plain git runs them.
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "control");
    expect(markers()).toContain("pre-commit.configured-ran");
  });

  it("a commit where no identity is configured is the loop's own, with the message as written", async () => {
    for (const key of IDENTITY_ENV) delete process.env[key];
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    git(dir, "init");
    writeFileSync(join(dir, "a.txt"), "a");
    await gitAdd(dir, "a.txt");
    const message = `chunk 1: "quoted" — two words\n\nbody line`;
    expect((await gitCommit(dir, message)).committed).toBe(true);
    expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe("lax-auto-build <auto-build@localagentx.local>\n");
    expect(git(dir, "log", "-1", "--format=%B").trim()).toBe(message);
  });

  it("fails closed while the Windows cage proof is pending: no git runs", async () => {
    seam.proofPending = true;
    await expect(getHeadSha(dir)).rejects.toThrow(SANDBOX_PROOF_PENDING_RETRY);
    await expect(ensureGitBaseline(dir)).rejects.toThrow(SANDBOX_PROOF_PENDING_RETRY);
    expect(seam.wrapped).toEqual([]);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("under the Windows cage git may use a repo its account does not own", async () => {
    seam.mode = "guarded";
    writeFileSync(join(dir, "a.txt"), "a");
    await ensureGitBaseline(dir);
    expect(seam.wrapped.length).toBeGreaterThan(4);
    for (const { args } of seam.wrapped) {
      expect(args.slice(HARDENED.length, HARDENED.length + 2)).toEqual(["-c", "safe.directory=*"]);
    }
  });

  it.skipIf(process.platform !== "win32")("a git.exe planted in the project or on a relative PATH entry is never the one run", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "planted-git-"));
    const path = process.env.PATH;
    const cwd = process.cwd();
    try {
      writeFileSync(join(dir, "git.exe"), "");
      writeFileSync(join(elsewhere, "git.exe"), "");
      // From a cwd on the same drive: relative() across drives (a CI checkout
      // on D:, temp on C:) returns an absolute path, and an absolute entry is
      // a fair place to find git.
      process.chdir(tmpdir());
      const entry = relative(process.cwd(), elsewhere);
      expect(isAbsolute(entry)).toBe(false);
      process.env.PATH = `${entry};${path}`;
      await getHeadSha(dir).catch(() => undefined);
    } finally {
      process.chdir(cwd);
      process.env.PATH = path;
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const { file } = seam.wrapped[0];
    expectGitProgram(file);
    expect([join(dir, "git.exe"), join(elsewhere, "git.exe")]).not.toContain(file);
  });
});

// Companion backstop: the halt reason is rewritten to disk on every event
// and broadcast to chat — it must stay a message even if a caller hands it
// a stderr dump.
describe("markHalted caps the persisted halt reason", () => {
  it("truncates megabyte reasons to ~4KB", () => {
    const s = makeInitial({ opId: "op_x", sessionId: "s", projectDir: "/p", planPath: "/p/spec/plan.md", totalChunks: 3, startingChunk: 1 });
    const halted = markHalted(s, 1, "loop-halt", "w".repeat(4_000_000));
    expect(halted.haltReason.length).toBeLessThan(4100);
    expect(halted.haltReason).toContain("[truncated]");
  });
});
