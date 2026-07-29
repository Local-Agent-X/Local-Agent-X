/**
 * The build gate used to exist twice: an async spawn form for registered
 * worktrees (gateBuild) and a synchronous execSync twin for candidate trees
 * (gateBuildAt), free to drift apart on env, output handling and verdict text.
 *
 * These pin the unification — the same tree yields the same verdict whether it
 * is addressed by worktree name or by path — and the reason for it: the async
 * form leaves the event loop free while npm runs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { activeWorktrees } from "../agency/worktree-core.js";
import { gateBuild, gateBuildAtAsync } from "./sandbox-gates.js";

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

// ── The blocking twin must be gone, not merely unused ───────────────────────
describe("gateBuildAt retirement", () => {
  it("the execSync twin is no longer exported", async () => {
    const mod = await import("./sandbox-gates.js");
    expect("gateBuildAt" in mod).toBe(false);
  });

  it("the update pipeline awaits the async gate instead", () => {
    const pipeline = readFileSync(fileURLToPath(new URL("../update-pipeline.ts", import.meta.url)), "utf-8");
    // `gateBuildAt(` would park the loop for up to BUILD_TIMEOUT_MS (5 min) on
    // the tarball path — the exact freeze this conversion exists to remove.
    expect(pipeline).not.toMatch(/\bgateBuildAt\(/);
    expect(pipeline).toMatch(/await gateBuildAtAsync\(/);
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
