// Workspace-lifecycle safety guard. Proves the 2026-06-10 data-loss incident
// can't recur: a workspace target under a system temp root must never cause the
// lifecycle to migrate (move-delete) the user's real, populated workspace.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CAN_CREATE_DIRECTORY_LINK } from "../symlink-capabilities.test-helper.js";
import { ensureWorkspaceLink, isEphemeralPath } from "./lifecycle.js";

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

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
