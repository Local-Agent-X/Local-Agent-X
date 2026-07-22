// Workspace-lifecycle safety guard. Proves the 2026-06-10 data-loss incident
// can't recur: a workspace target under a system temp root must never cause the
// lifecycle to migrate (move-delete) the user's real, populated workspace.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CAN_CREATE_DIRECTORY_LINK } from "../symlink-capabilities.test-helper.js";
import { ensureWorkspaceLink, isEphemeralPath, migrateWorkspace } from "./lifecycle.js";

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

describe("migrateWorkspace never relocates version-control / dependency trees", () => {
  it("leaves .git, .worktrees, node_modules, .pnpm-store, and nested repos in the source (2026-07-22 incident)", () => {
    const old = mkdtempSync(join(tmpdir(), "lax-mig-old-")); cleanup.push(old);
    const dest = mkdtempSync(join(tmpdir(), "lax-mig-new-")); cleanup.push(dest);
    // A real workspace payload that SHOULD migrate…
    mkdirSync(join(old, "apps"), { recursive: true });
    writeFileSync(join(old, "apps", "keep.txt"), "real content", "utf-8");
    // …alongside the trees that must NEVER be moved (moving .git/objects is what
    // destroyed the repo).
    mkdirSync(join(old, ".git", "objects", "pack"), { recursive: true });
    writeFileSync(join(old, ".git", "objects", "pack", "pack-abc.pack"), "OBJECTS", "utf-8");
    mkdirSync(join(old, ".worktrees", "c4"), { recursive: true });
    writeFileSync(join(old, ".worktrees", "c4", "x"), "wt", "utf-8");
    mkdirSync(join(old, "node_modules", "left-pad"), { recursive: true });
    // A nested git repo the user parked inside the workspace: must stay whole.
    mkdirSync(join(old, "myproject", ".git"), { recursive: true });
    writeFileSync(join(old, "myproject", "src.ts"), "code", "utf-8");

    migrateWorkspace(old, dest);

    // The real payload moved.
    expect(existsSync(join(dest, "apps", "keep.txt"))).toBe(true);
    // The dangerous trees did NOT move and are still intact at the source.
    expect(existsSync(join(old, ".git", "objects", "pack", "pack-abc.pack"))).toBe(true);
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(existsSync(join(old, ".worktrees", "c4", "x"))).toBe(true);
    expect(existsSync(join(dest, ".worktrees"))).toBe(false);
    expect(existsSync(join(old, "node_modules", "left-pad"))).toBe(true);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    // The nested repo was left whole in the source, its .git intact.
    expect(existsSync(join(old, "myproject", ".git"))).toBe(true);
    expect(existsSync(join(dest, "myproject"))).toBe(false);
  });
});

describe("isEphemeralPath", () => {
  it("flags system temp roots, including the incident path", () => {
    expect(isEphemeralPath("/tmp/lax-smoke/workspace")).toBe(true);
    expect(isEphemeralPath("/private/tmp/foo")).toBe(true);
    expect(isEphemeralPath(join(tmpdir(), "anything"))).toBe(true);
  });
  it("treats real user locations as persistent", () => {
    // Env-independent absolute paths (the test harness points HOME at a temp
    // dir, so homedir()-based paths would themselves be ephemeral here).
    expect(isEphemeralPath("/Users/someone/Documents/Local Agent X/workspace")).toBe(false);
    expect(isEphemeralPath("/opt/lax/workspace")).toBe(false);
    expect(isEphemeralPath(process.cwd())).toBe(false);
  });
});

describe("ensureWorkspaceLink ephemeral guard", () => {
  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("refuses to migrate a real populated workspace into an ephemeral target", () => {
    // A real (non-ephemeral) workspace lives under cwd, not under /tmp.
    const realWs = mkdtempSync(join(process.cwd(), ".guard-ws-"));
    cleanup.push(realWs);
    mkdirSync(join(realWs, "apps"));
    writeFileSync(join(realWs, "apps", "keep.txt"), "important", "utf-8");

    // The cwd `workspace` symlink points at it.
    const linkHost = mkdtempSync(join(process.cwd(), ".guard-link-"));
    cleanup.push(linkHost);
    const link = join(linkHost, "workspace");
    symlinkSync(realWs, link, process.platform === "win32" ? "junction" : "dir");

    // A smoke/test run points config.workspace at an ephemeral location.
    const ephHost = mkdtempSync(join(tmpdir(), "lax-eph-"));
    cleanup.push(ephHost);
    const ephTarget = join(ephHost, "workspace");

    ensureWorkspaceLink(ephTarget, link);

    // The real workspace and its file are untouched (not move-deleted)...
    expect(existsSync(join(realWs, "apps", "keep.txt"))).toBe(true);
    // ...and the link was NOT repointed at the ephemeral target.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(link))).toBe(resolve(realWs));
  });
});
