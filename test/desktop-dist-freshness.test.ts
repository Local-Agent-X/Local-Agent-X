// Regression: every update touching desktop/src forced a double boot —
// reconcile rebuilt desktop/dist and relaunched even when a gated update had
// already pre-built it. The fix routes that decision through desktopDistIsFresh
// (mtime: dist newer than every src .ts), so reconcile skips the rebuild AND
// the relaunch when the loaded main process is already current. The dangerous
// direction is a FALSE-fresh: it would skip a real rebuild and boot stale
// main-process code — so the boundary is pinned both ways here against real
// files and explicit mtimes (no mocks; the bug lives in the mtime walk).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverDistIsFresh, desktopDistIsFresh, currentGitHead } from "../desktop/src/dist-freshness";

const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-01-01T01:00:00Z");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-freshness-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAt(path: string, time: Date): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  utimesSync(path, time, time);
}

describe("desktopDistIsFresh", () => {
  const distMain = () => join(root, "desktop", "dist", "main.js");
  const src = (...p: string[]) => join(root, "desktop", "src", ...p);

  it("is fresh when dist/main.js is newer than every src .ts", () => {
    writeAt(src("main.ts"), OLD);
    writeAt(src("ipc", "handlers.ts"), OLD);
    writeAt(distMain(), NEW);
    expect(desktopDistIsFresh(root)).toBe(true);
  });

  it("is STALE when any src .ts (even nested) is newer than dist — the relaunch case", () => {
    writeAt(src("main.ts"), OLD);
    writeAt(distMain(), NEW);
    writeAt(src("ipc", "handlers.ts"), new Date("2026-01-01T02:00:00Z"));
    expect(desktopDistIsFresh(root)).toBe(false);
  });

  it("is stale when dist/main.js is missing", () => {
    writeAt(src("main.ts"), OLD);
    expect(desktopDistIsFresh(root)).toBe(false);
  });

  it("ignores non-.ts files newer than dist", () => {
    writeAt(src("main.ts"), OLD);
    writeAt(distMain(), NEW);
    writeAt(src("notes.md"), new Date("2026-01-01T03:00:00Z"));
    expect(desktopDistIsFresh(root)).toBe(true);
  });
});

describe("serverDistIsFresh (shared walk did not regress in the refactor)", () => {
  it("fresh vs stale by dist/index.js mtime", () => {
    writeAt(join(root, "src", "index.ts"), OLD);
    writeAt(join(root, "dist", "index.js"), NEW);
    expect(serverDistIsFresh(root)).toBe(true);

    utimesSync(join(root, "src", "index.ts"), new Date("2026-01-01T04:00:00Z"), new Date("2026-01-01T04:00:00Z"));
    expect(serverDistIsFresh(root)).toBe(false);
  });
});

// Sets up a fake git checkout with HEAD resolving to `sha`, and stamps
// dist/.builtref with `builtSha` (omit to leave dist unstamped).
function fakeGit(sha: string, builtSha?: string, packed = false): void {
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  if (packed) {
    writeFileSync(join(gitDir, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`);
  } else {
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "refs", "heads", "main"), sha + "\n");
  }
  if (builtSha !== undefined) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", ".builtref"), builtSha + "\n");
  }
}

describe("git-HEAD stamp — catches a pull the mtime sweep misses", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  // Baseline for all cases: dist is mtime-fresh, so the git stamp is the only
  // thing that can flip the verdict.
  beforeEach(() => {
    writeAt(join(root, "src", "index.ts"), OLD);
    writeAt(join(root, "dist", "index.js"), NEW);
  });

  it("fresh when the stamped commit equals HEAD", () => {
    fakeGit(SHA_A, SHA_A);
    expect(serverDistIsFresh(root)).toBe(true);
  });

  it("STALE when HEAD moved past the stamp (the git pull that didn't show up)", () => {
    fakeGit(SHA_B, SHA_A); // built from A, now on B
    expect(serverDistIsFresh(root)).toBe(false);
  });

  it("defers to mtime (fresh) when dist carries no stamp — no regression for deployed dist", () => {
    fakeGit(SHA_A); // .git present, but no dist/.builtref
    expect(serverDistIsFresh(root)).toBe(true);
  });

  it("defers to mtime when there is no .git (the installed-app / OTA case)", () => {
    // no fakeGit() call → no .git; a stray stamp must not engage the check
    writeFileSync(join(root, "dist", ".builtref"), SHA_B + "\n");
    expect(serverDistIsFresh(root)).toBe(true);
  });

  it("can only ADD staleness: an mtime-STALE dist stays stale regardless of a matching stamp", () => {
    utimesSync(join(root, "src", "index.ts"), new Date("2026-01-01T05:00:00Z"), new Date("2026-01-01T05:00:00Z"));
    fakeGit(SHA_A, SHA_A); // stamp matches HEAD, but src is newer than dist
    expect(serverDistIsFresh(root)).toBe(false);
  });
});

describe("currentGitHead", () => {
  const SHA = "c".repeat(40);
  it("resolves a loose ref via HEAD", () => {
    fakeGit(SHA);
    expect(currentGitHead(root)).toBe(SHA);
  });
  it("resolves a packed ref when the loose file is absent", () => {
    fakeGit(SHA, undefined, /* packed */ true);
    expect(currentGitHead(root)).toBe(SHA);
  });
  it("returns a detached-HEAD sha directly", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), SHA + "\n");
    expect(currentGitHead(root)).toBe(SHA);
  });
  it("returns null when not a git checkout", () => {
    expect(currentGitHead(root)).toBeNull();
  });
});
