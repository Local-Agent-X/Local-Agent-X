/**
 * The build gate used to exist twice: an async spawn form for registered
 * worktrees (gateBuild) and a synchronous execSync twin for candidate trees
 * (gateBuildAt), free to drift apart on env, output handling and verdict text.
 *
 * These pin the unification — the same tree yields the same verdict whether it
 * is addressed by worktree name or by path — and the reason for it: the async
 * form leaves the event loop free while npm runs. The deps gate's `npm ci` is
 * pinned to the same credential-scrubbed env as the build.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { activeWorktrees } from "../agency/worktree-core.js";
import { gateBuild, gateBuildAtAsync, gateDeps } from "./sandbox-gates.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
const dirs: string[] = [];
const names: string[] = [];

/** A throwaway tree with the given `build` script, registered as a worktree so
 *  it can be addressed BOTH ways. */
function registerTree(buildScript: string): { name: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lax-gate-"));
  const name = `gate-${process.pid}-${names.length}`;
  dirs.push(dir);
  names.push(name);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gate-fixture", version: "0.0.0", private: true, scripts: { build: buildScript } }),
  );
  activeWorktrees.set(name, {
    path: dir,
    branch: `agent/${name}`,
    baseBranch: "main",
    repoRoot: dir,
    mergedSuccessfully: false,
  });
  return { name, dir };
}

afterEach(() => {
  for (const n of names.splice(0)) activeWorktrees.delete(n);
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* %TEMP% reclaims it */ }
  }
});

// ── One build gate, two addressing modes ─────────────────────────────────────
describe("build gate unification", () => {
  it("fails the same way by name and by path, carrying the build's own output", async () => {
    const { name, dir } = registerTree(`node -e "console.error('gate build blew up'); process.exit(1)"`);

    const byName = await gateBuild(name);
    const byPath = await gateBuildAtAsync(dir);

    expect(byName.ok).toBe(false);
    expect(byPath.ok).toBe(byName.ok);
    expect(byPath.skipped).toBe(byName.skipped);
    expect(byName.detail).toContain("gate build blew up");
    expect(byPath.detail).toContain("gate build blew up");
  }, 120_000);

  it("passes the same way by name and by path", async () => {
    const { name, dir } = registerTree(`node -e "console.log('gate built')"`);

    const byName = await gateBuild(name);
    const byPath = await gateBuildAtAsync(dir);

    expect(byName).toMatchObject({ ok: true, skipped: false, detail: "build passed" });
    expect(byPath).toMatchObject({ ok: true, skipped: false, detail: "build passed" });
  }, 120_000);

  it("reports a missing worktree instead of running anything", async () => {
    const r = await gateBuild("no-such-worktree");
    expect(r).toMatchObject({ ok: false, skipped: false, durationMs: 0, detail: "worktree path not found" });
  });
});

// ── The deps gate installs without the server's credentials ─────────────────
const PROBE_SECRET_KEY = "LAX_SCRUB_PROBE_API_KEY";
const PROBE_SECRET_VALUE = "sk-scrub-probe-6f1d0c2a9b8e7d3c";

/** A git repo whose uncommitted manifest change puts it in the deps gate's
 *  merge delta, with a postinstall that records the env npm ci handed it. */
function registerDepsTree(): { name: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lax-gate-deps-"));
  const name = `gate-${process.pid}-${names.length}`;
  dirs.push(dir);
  names.push(name);
  const g = (...args: string[]) => execFileSync("git", args, {
    cwd: dir, stdio: "pipe", windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  g("init", "-q", "-b", "main");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(dir, "dump-env.cjs"), `require("node:fs").writeFileSync("env.json", JSON.stringify(process.env));\n`);
  const manifest = { name: "deps-fixture", version: "0.0.0", private: true, scripts: { postinstall: "node dump-env.cjs" } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
    name: "deps-fixture", version: "0.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "deps-fixture", version: "0.0.0" } },
  }));
  activeWorktrees.set(name, { path: dir, branch: "main", baseBranch: "main", repoRoot: dir, mergedSuccessfully: false });
  return { name, dir };
}

describe("gateDeps env", () => {
  it("runs npm ci lifecycle scripts without a credential from the server env", async () => {
    const { name, dir } = registerDepsTree();
    process.env[PROBE_SECRET_KEY] = PROBE_SECRET_VALUE;
    let r: Awaited<ReturnType<typeof gateDeps>>;
    try { r = await gateDeps(name); } finally { delete process.env[PROBE_SECRET_KEY]; }

    expect(r).toMatchObject({ ok: true, skipped: false, detail: "isolated npm ci passed" });
    const childEnv = JSON.parse(readFileSync(join(dir, "env.json"), "utf-8")) as Record<string, string>;
    expect(childEnv).not.toHaveProperty(PROBE_SECRET_KEY);
    expect(JSON.stringify(childEnv)).not.toContain(PROBE_SECRET_VALUE);
  }, 120_000);
});

// ── The blocking twin must be gone, not merely unused ───────────────────────
describe("gateBuildAt retirement", () => {
  it("the execSync twin is no longer exported", async () => {
    const mod = await import("./sandbox-gates.js");
    expect("gateBuildAt" in mod).toBe(false);
  });

  it("the update pipeline awaits the async gate instead", () => {
    const pipeline = readFileSync(fileURLToPath(new URL("../update-pipeline.ts", import.meta.url)), "utf-8");
    const extractedValidation = readFileSync(fileURLToPath(new URL("../update-extracted-validation.ts", import.meta.url)), "utf-8");
    // `gateBuildAt(` would park the loop for up to BUILD_TIMEOUT_MS (5 min) on
    // the tarball path — the exact freeze this conversion exists to remove.
    expect(pipeline).not.toMatch(/\bgateBuildAt\(/);
    expect(extractedValidation).toMatch(/await gateBuildAtAsync\(/);
    // Rolling assets carry tracked source, not desktop/dist. The candidate
    // must compile desktop/src before the updater is allowed to copy it live.
    expect(extractedValidation).toMatch(/await runDesktopTscBuildAsync\(extractDir,/);
  });
});

// ── The reason gateBuildAt had to stop being synchronous ─────────────────────
describe("event-loop occupancy", () => {
  it("gateBuildAtAsync lets timers fire while npm runs", async () => {
    const { dir } = registerTree(`node -e "setTimeout(function () {}, 1000)"`);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    try { await gateBuildAtAsync(dir); } finally { clearInterval(timer); }
    // execSync scored 0 here for the whole npm run — up to BUILD_TIMEOUT_MS.
    expect(ticks).toBeGreaterThan(5);
  }, 120_000);
});
