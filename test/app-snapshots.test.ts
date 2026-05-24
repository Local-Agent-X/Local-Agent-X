import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// HOME has to be set BEFORE we import the snapshots module, because some
// builds of node resolve homedir() lazily — to be safe we set process.env
// before importing and tear down after. The functions use homedir() at
// call-time, so we can also flip it per-test.
import {
  snapshotAppTurn,
  listAppSnapshots,
  revertAppToSnapshot,
  extractAppTouchesFromToolCalls,
  SNAPSHOTS_TO_KEEP,
} from "../src/app-tools/snapshots.js";

const APP_ID = "test-app";

let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let tmpRoot: string;
let workspaceDir: string;
let appDir: string;

function makeFile(rel: string, content: string): string {
  const abs = join(appDir, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lax-snap-test-"));
  // homedir() reads HOME on POSIX and USERPROFILE on Windows. Patch both
  // so this test passes on either OS without forking the assertions.
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  workspaceDir = join(tmpRoot, "workspace");
  appDir = resolve(workspaceDir, "apps", APP_ID);
  mkdirSync(appDir, { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("snapshotAppTurn", () => {
  it("copies touched files into the snapshot dir preserving relative paths", () => {
    const indexAbs = makeFile("index.html", "<h1>v1</h1>");
    const cssAbs = makeFile("style/site.css", "body{color:red}");
    const result = snapshotAppTurn(APP_ID, workspaceDir, 4, [indexAbs, cssAbs]);
    expect(result).not.toBeNull();
    expect(result!.copied.sort()).toEqual(["index.html", "style/site.css"]);
    expect(existsSync(join(result!.snapshotDir, "index.html"))).toBe(true);
    expect(existsSync(join(result!.snapshotDir, "style/site.css"))).toBe(true);
    expect(readFileSync(join(result!.snapshotDir, "index.html"), "utf-8")).toBe("<h1>v1</h1>");
  });

  it("skips files outside the app dir (security check)", () => {
    const outside = join(tmpRoot, "evil.txt");
    writeFileSync(outside, "secret");
    const indexAbs = makeFile("index.html", "ok");
    const result = snapshotAppTurn(APP_ID, workspaceDir, 1, [indexAbs, outside]);
    expect(result).not.toBeNull();
    expect(result!.copied).toEqual(["index.html"]);
  });

  it("skips directories silently", () => {
    const indexAbs = makeFile("index.html", "ok");
    const subDir = join(appDir, "assets");
    mkdirSync(subDir, { recursive: true });
    const result = snapshotAppTurn(APP_ID, workspaceDir, 2, [indexAbs, subDir]);
    expect(result).not.toBeNull();
    expect(result!.copied).toEqual(["index.html"]);
  });

  it("returns null when no touched files exist", () => {
    expect(snapshotAppTurn(APP_ID, workspaceDir, 1, [])).toBeNull();
  });
});

describe("listAppSnapshots", () => {
  it("returns newest first, capped at SNAPSHOTS_TO_KEEP", async () => {
    const indexAbs = makeFile("index.html", "v0");
    // Create more than SNAPSHOTS_TO_KEEP. Stagger ts via real time —
    // snapshotAppTurn uses Date.now() so a 2ms gap is enough to keep them
    // distinct. Re-write the file each turn so the copy succeeds.
    for (let i = 0; i < SNAPSHOTS_TO_KEEP + 3; i++) {
      writeFileSync(indexAbs, "v" + i, "utf-8");
      snapshotAppTurn(APP_ID, workspaceDir, i, [indexAbs]);
      await new Promise(r => setTimeout(r, 3));
    }
    const list = listAppSnapshots(APP_ID);
    expect(list.length).toBe(SNAPSHOTS_TO_KEEP);
    // Newest first.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].ts).toBeGreaterThanOrEqual(list[i].ts);
    }
    // Newest entry should be the last turn we wrote.
    expect(list[0].turnIdx).toBe(SNAPSHOTS_TO_KEEP + 2);
    expect(list[0].files).toContain("index.html");
  });

  it("returns [] when there are no snapshots yet", () => {
    expect(listAppSnapshots("nonexistent-app")).toEqual([]);
  });
});

describe("revertAppToSnapshot", () => {
  it("restores files and returns the restored list", () => {
    const indexAbs = makeFile("index.html", "ORIGINAL");
    const snap = snapshotAppTurn(APP_ID, workspaceDir, 7, [indexAbs])!;
    // Simulate the agent breaking the file on a later turn.
    writeFileSync(indexAbs, "BROKEN", "utf-8");
    const list = listAppSnapshots(APP_ID);
    expect(list[0].turnIdx).toBe(7);
    const result = revertAppToSnapshot(APP_ID, workspaceDir, 7, list[0].ts);
    expect(result.errors).toEqual([]);
    expect(result.restored).toEqual(["index.html"]);
    expect(readFileSync(indexAbs, "utf-8")).toBe("ORIGINAL");
    void snap;
  });

  it("is idempotent — reverting twice doesn't error", () => {
    const indexAbs = makeFile("index.html", "OK");
    snapshotAppTurn(APP_ID, workspaceDir, 1, [indexAbs]);
    const snaps = listAppSnapshots(APP_ID);
    const first = revertAppToSnapshot(APP_ID, workspaceDir, 1, snaps[0].ts);
    const second = revertAppToSnapshot(APP_ID, workspaceDir, 1, snaps[0].ts);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.restored).toEqual(first.restored);
    expect(readFileSync(indexAbs, "utf-8")).toBe("OK");
  });

  it("returns an error for a snapshot that doesn't exist", () => {
    const result = revertAppToSnapshot(APP_ID, workspaceDir, 999, 12345);
    expect(result.restored).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/not found/i);
  });
});

describe("extractAppTouchesFromToolCalls", () => {
  it("groups write/edit paths by appId, ignoring other tools and non-app paths", () => {
    const calls = [
      { tool: "write", args: { path: "workspace/apps/foo/index.html" } },
      { tool: "edit",  args: { path: "workspace/apps/foo/style.css" } },
      { tool: "write", args: { path: "workspace/apps/bar/app.js" } },
      { tool: "bash",  args: { command: "echo hi > workspace/apps/foo/sneaky.txt" } },
      { tool: "read",  args: { path: "workspace/apps/foo/index.html" } },
      { tool: "write", args: { path: "/etc/passwd" } },
    ];
    const map = extractAppTouchesFromToolCalls(calls);
    expect(Array.from(map.keys()).sort()).toEqual(["bar", "foo"]);
    expect(map.get("foo")!.length).toBe(2);
    expect(map.get("bar")!.length).toBe(1);
  });

  it("handles Windows backslash paths", () => {
    const calls = [
      { tool: "write", args: { path: "C:\\Users\\x\\workspace\\apps\\myapp\\index.html" } },
    ];
    const map = extractAppTouchesFromToolCalls(calls);
    expect(map.get("myapp")!.length).toBe(1);
  });

  it("ignores the _audit pseudo-app", () => {
    const calls = [
      { tool: "write", args: { path: "workspace/apps/_audit/log.json" } },
    ];
    expect(extractAppTouchesFromToolCalls(calls).size).toBe(0);
  });
});
