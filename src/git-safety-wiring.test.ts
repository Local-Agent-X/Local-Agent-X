/**
 * Wiring proofs for the git-safety backstop: EVERY app git path that mutates a
 * real checkout must carry `-c gc.auto=0`, so a momentarily-severed reachability
 * root can never let auto-gc prune a shared object store.
 *
 * The pure composers (composeGitArgs / gitSafeCmd) are unit-tested in
 * agency/worktree-git-safety.test.ts against real git. THIS file proves the
 * three call sites the first pass missed are actually wired to them, by
 * intercepting the spawned argv / command string:
 *   - auto-build/git-helpers.ts  (spawn array — commit/add/init)
 *   - autonomy/rollback.ts       (execSync string — stash push/apply/drop)
 *   - update-service.ts          (execSync string — fetch origin main)
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
const execCalls: string[] = [];
const execSyncImpl = vi.fn<(cmd: string) => string>();

// Override ONLY execSync + spawn; keep every other child_process export real so
// unrelated importers (process-tree-kill etc.) still load.
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: (cmd: string, ...rest: unknown[]) => {
      execCalls.push(cmd);
      void rest;
      return execSyncImpl(cmd);
    },
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => void; end: () => void };
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: () => {}, end: () => {} };
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n"));
        proc.emit("close", 0);
      });
      return proc;
    },
  };
});

// update-service pulls in getRuntimeConfig transitively via isLocalOnlyMode;
// stub the policy so the check runs offline without booting real config.
vi.mock("./local-only-policy.js", () => ({
  isLocalOnlyMode: () => false,
  LOCAL_ONLY_BLOCK_MESSAGE: "blocked",
}));

import { getHeadSha } from "./auto-build/git-helpers.js";
import { captureRollback } from "./autonomy/rollback.js";
import { checkForUpdate, bustUpdateCache } from "./update-service.js";

beforeEach(() => {
  spawnCalls.length = 0;
  execCalls.length = 0;
  execSyncImpl.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("git-helpers spawn carries gc.auto=0", () => {
  it("prepends -c gc.auto=0 to the spawned argv (all ops inherit the single seam)", async () => {
    await getHeadSha("/nonexistent/cwd");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("git");
    // Flags come FIRST, before the subcommand, so git parses them as config.
    expect(spawnCalls[0].args.slice(0, 2)).toEqual(["-c", "gc.auto=0"]);
    expect(spawnCalls[0].args).toEqual(["-c", "gc.auto=0", "rev-parse", "HEAD"]);
  });
});

describe("rollback stash carries gc.auto=0", () => {
  it("wraps `git stash push` (the object-creating mutation) with -c gc.auto=0", () => {
    execSyncImpl.mockImplementation((cmd) => {
      if (/is-inside-work-tree/.test(cmd)) return "";
      if (/status --porcelain/.test(cmd)) return "M a.txt\n";
      if (/stash push/.test(cmd)) return "";
      if (/rev-parse stash/.test(cmd)) return "a".repeat(40) + "\n";
      return "";
    });
    // A temp cwd (no src/autonomy/rollback.ts) clears captureGitStash's
    // self-protect guard so the stash path actually runs.
    const dir = mkdtempSync(join(tmpdir(), "lax-gitsafety-rb-"));
    try {
      const contract = captureRollback("test-gitsafety-rb", "bash", "shell", { command: "x" }, dir);
      expect(contract.artifacts[0].type).toBe("git-stash");
      const push = execCalls.find((c) => /stash push/.test(c));
      expect(push).toBeDefined();
      expect(push).toContain("-c gc.auto=0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("update-service fetch carries gc.auto=0", () => {
  it("wraps `git fetch origin main` — the fetch-on-live-checkout that trips auto-gc", async () => {
    execSyncImpl.mockImplementation((cmd) => {
      if (/rev-parse --short HEAD/.test(cmd)) return "abc1234\n";
      if (/fetch origin main/.test(cmd)) return "";
      if (/rev-parse --short origin\/main/.test(cmd)) return "def5678\n";
      if (/show origin\/main:package\.json/.test(cmd)) return '{"version":"9.9.9"}';
      if (/log -1/.test(cmd)) return "subject line\n";
      if (/rev-list --count/.test(cmd)) return "0\n";
      return "";
    });
    bustUpdateCache();
    await checkForUpdate(true);
    const fetch = execCalls.find((c) => /fetch origin main/.test(c));
    expect(fetch).toBeDefined();
    expect(fetch).toContain("-c gc.auto=0");
  });
});
