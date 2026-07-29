/**
 * The build/test runners in worktree-state used execSync, which parks the whole
 * event loop for the child's entire lifetime — and their ceilings are minutes,
 * so one repo build stopped the server answering anything at all.
 *
 * These pin the async runners' contract (exit codes, stderr, env passthrough,
 * the timeout ceiling) and the property the conversion exists for: timers keep
 * firing while the child runs.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { activeWorktrees } from "./worktree-core.js";
import {
  runCommandInWorktreeAsync,
  runDesktopTscBuildAsync,
  runRepoBuildAsync,
} from "./worktree-state.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
const dirs: string[] = [];
const names: string[] = [];

/** Register a throwaway dir as a worktree so the runners resolve a cwd. */
function registerWorktree(): { name: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lax-runner-"));
  const name = `runner-${process.pid}-${names.length}`;
  dirs.push(dir);
  names.push(name);
  activeWorktrees.set(name, {
    path: dir,
    branch: `agent/${name}`,
    baseBranch: "main",
    repoRoot: dir,
    mergedSuccessfully: false,
  });
  return { name, dir };
}

/** Give `dir` a package.json whose `build` script is exactly `script`. */
function writeBuildScript(dir: string, script: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "runner-fixture", version: "0.0.0", private: true, scripts: { build: script } }),
  );
}

/**
 * Timer ticks that actually fired WHILE `run` was in flight. A blocking runner
 * never yields to the timer phase, so this is 0 for it — that is the whole
 * difference between the two forms.
 */
async function ticksDuring(run: () => unknown): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  try { await run(); } finally { clearInterval(timer); }
  return ticks;
}

afterEach(() => {
  for (const n of names.splice(0)) activeWorktrees.delete(n);
  // Best-effort: a timed-out child's descendants are tree-killed before the
  // wrapper dies, so nothing should still hold this cwd — but AV scanners and
  // Windows handle latency can still lose a race, and %TEMP% reclaims the rest.
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* handle latency */ }
  }
});

// ── runCommandInWorktreeAsync ────────────────────────────────────────────────
describe("runCommandInWorktreeAsync", () => {
  it("resolves ok with the child's stdout on a clean exit", async () => {
    const { name } = registerWorktree();
    const r = await runCommandInWorktreeAsync(name, {
      command: `node -e "console.log('hi-from-child')"`,
      timeoutMs: 30_000,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hi-from-child");
  });

  it("propagates a non-zero exit as a failure carrying the child's stderr", async () => {
    const { name } = registerWorktree();
    const r = await runCommandInWorktreeAsync(name, {
      command: `node -e "console.error('boom'); process.exit(3)"`,
      timeoutMs: 30_000,
    });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("boom");
  });

  it("kills the child at timeoutMs and reports it, instead of hanging", async () => {
    const { name } = registerWorktree();
    const r = await runCommandInWorktreeAsync(name, {
      command: `node -e "setTimeout(function () {}, 60000)"`,
      timeoutMs: 700,
    });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("timed out after 700ms");
    expect(r.durationMs).toBeLessThan(30_000);
  });

  it("passes the caller's env through to the child", async () => {
    const { name } = registerWorktree();
    const r = await runCommandInWorktreeAsync(name, {
      command: `node -e "console.log(process.env.LAX_RUNNER_MARKER)"`,
      timeoutMs: 30_000,
      env: { ...process.env, LAX_RUNNER_MARKER: "scrubbed-env-reached-child" },
    });
    expect(r.stdout).toContain("scrubbed-env-reached-child");
  });

  it("rejects for an unregistered worktree", async () => {
    await expect(
      runCommandInWorktreeAsync("no-such-worktree", { command: "node -v", timeoutMs: 5_000 }),
    ).rejects.toThrow(/No worktree found/);
  });
});

// ── The reason the conversion exists ─────────────────────────────────────────
describe("event-loop occupancy", () => {
  it("the async runner lets timers fire while the child runs; a blocking one does not", async () => {
    const { name, dir } = registerWorktree();
    const command = `node -e "setTimeout(function () {}, 1000)"`;

    const asyncTicks = await ticksDuring(() => runCommandInWorktreeAsync(name, { command, timeoutMs: 30_000 }));
    // The control is the execSync call the deleted sync twin made, verbatim.
    // The contrast IS the property under test, and the twin itself is gone now
    // that both of its callers await — so the control lives here instead.
    const syncTicks = await ticksDuring(() => execSync(command, { cwd: dir, timeout: 30_000, windowsHide: true }));

    // ~1s of child life at a 20ms interval. execSync scores 0 — every timer,
    // socket and in-flight request waited for the child. Revert the async
    // runner to execSync and asyncTicks drops to 0 too.
    expect(asyncTicks).toBeGreaterThan(5);
    expect(syncTicks).toBe(0);
  }, 30_000);
});

// ── runRepoBuildAsync / runDesktopTscBuildAsync ──────────────────────────────
describe("runRepoBuildAsync", () => {
  it("reports the failing build's output as the detail", async () => {
    const { dir } = registerWorktree();
    writeBuildScript(dir, `node -e "console.error('build blew up'); process.exit(1)"`);
    const r = await runRepoBuildAsync(dir, 120_000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("build blew up");
  }, 90_000);

  it("passes when the repo's build script exits clean", async () => {
    const { dir } = registerWorktree();
    writeBuildScript(dir, `node -e "console.log('built')"`);
    expect(await runRepoBuildAsync(dir, 120_000)).toEqual({ ok: true, detail: "build passed" });
  }, 90_000);
});

describe("runDesktopTscBuildAsync", () => {
  it("resolves as a failure when there is no desktop/ tree, rather than throwing", async () => {
    // A spawn that can't even start (missing cwd) must land as ok:false with a
    // reason — not an unhandled rejection the update pipeline never sees.
    const { dir } = registerWorktree();
    const r = await runDesktopTscBuildAsync(dir, 20_000);
    expect(r.ok).toBe(false);
    expect(r.detail.length).toBeGreaterThan(0);
  }, 60_000);
});

// ── Output fidelity ──────────────────────────────────────────────────────────
describe("runner output decoding", () => {
  it("decodes multi-byte output that straddles a pipe-chunk boundary", async () => {
    const { name, dir } = registerWorktree();
    // Emitted from a file, not through the shell, so no console codepage can
    // mangle it before the pipe. 3-byte characters + a 64 KiB read boundary
    // (65536 % 3 === 1) guarantee a character is split across two chunks; a
    // per-chunk `stdout += buffer` decodes each half separately and yields
    // U+FFFD where the character was.
    writeFileSync(join(dir, "emit.cjs"), `process.stdout.write("\\u6f22".repeat(200000));\n`);
    const r = await runCommandInWorktreeAsync(name, { command: "node emit.cjs", timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.stdout).not.toContain("�");
    expect(r.stdout.length).toBe(200_000);
  }, 60_000);
});

// ── Timeout must reap the whole tree, not just the shell wrapper ─────────────
describe("timeout tree-kill", () => {
  // Windows-only: on POSIX a non-detached spawn shares OUR process group, so
  // killProcessTree deliberately signals only the child (a negative-pid kill
  // would take down the server itself). The orphan class this pins is the
  // Windows one — cmd.exe wrapper → npm → tsc/vite grandchildren surviving a
  // build timeout and pegging every core.
  it.skipIf(process.platform !== "win32")("stops a grandchild the shell wrapper spawned", async () => {
    const { name, dir } = registerWorktree();
    const ticks = join(dir, "ticks.txt");
    writeFileSync(
      join(dir, "grandchild.cjs"),
      `const fs = require("node:fs");\n` +
      `setInterval(() => { try { fs.appendFileSync(${JSON.stringify(ticks)}, "x"); } catch {} }, 40);\n` +
      `setTimeout(() => process.exit(0), 60000);\n`,
    );
    writeFileSync(
      join(dir, "parent.cjs"),
      `const { spawn } = require("node:child_process");\n` +
      `const { join } = require("node:path");\n` +
      `spawn(process.execPath, [join(__dirname, "grandchild.cjs")], { stdio: "ignore" });\n` +
      `setTimeout(() => {}, 60000);\n`,
    );

    const r = await runCommandInWorktreeAsync(name, { command: "node parent.cjs", timeoutMs: 1_500 });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("timed out");

    // Give the kill a beat to propagate, then prove the grandchild stopped
    // writing. Before the fix it kept ticking for its full 60s lifetime.
    await new Promise(done => setTimeout(done, 1_200));
    const first = statSync(ticks).size;
    await new Promise(done => setTimeout(done, 1_200));
    expect(statSync(ticks).size).toBe(first);
  }, 60_000);
});

// ── Reachability: the async path must exist on the barrel every caller uses ──
describe("async runners are reachable from production", () => {
  it("the worktree barrel re-exports the async runners", async () => {
    // The whole point of the conversion. Production imports through
    // ./worktree.js; an async variant the barrel does not re-export is
    // unreachable code and the event loop still freezes for every build.
    const barrel = await import("./worktree.js");
    expect(typeof barrel.runRepoBuildAsync).toBe("function");
    expect(typeof barrel.runDesktopTscBuildAsync).toBe("function");
    expect(typeof barrel.runCommandInWorktreeAsync).toBe("function");
  });

  it("drops the blocking twins that no longer have a caller", async () => {
    const barrel = await import("./worktree.js");
    const state = await import("./worktree-state.js");
    // A twin left exported after its last caller migrated is an invitation for
    // the NEXT caller to reintroduce the block, so absence is the assertion.
    for (const twin of ["runDesktopTscBuild", "runRepoBuild", "runCommandInWorktree"]) {
      expect(twin in state, `${twin} in worktree-state`).toBe(false);
      expect(twin in barrel, `${twin} in worktree barrel`).toBe(false);
    }
  });

  it("no self-edit / update / autopilot caller still parks the loop on a build", () => {
    const src = fileURLToPath(new URL("../", import.meta.url));
    for (const rel of [
      "update-pipeline.ts", "self-edit/sandbox.ts", "self-edit/rollback.ts", "autopilot/validate.ts",
    ]) {
      const text = readFileSync(join(src, rel), "utf-8");
      expect(text, rel).not.toMatch(/\brunRepoBuild\(/);
      expect(text, rel).not.toMatch(/\brunDesktopTscBuild\(/);
      expect(text, rel).not.toMatch(/\brunCommandInWorktree\(/);
    }
  });
});
