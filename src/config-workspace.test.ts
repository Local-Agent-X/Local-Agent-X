import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripOneDriveDocuments, isCloudStoragePath, migrateWorkspace, ensureWorkspaceLink } from "./workspace/lifecycle.js";

// Regression: on Windows with OneDrive "Known Folder Move", the agent
// workspace was being placed under ...\OneDrive\Documents\Local Agent X, where
// the sync client locks files mid-write and breaks the atomic config rename.
// The workspace must map back to the real on-disk Documents.
describe("stripOneDriveDocuments", () => {
  it("drops the OneDrive segment before Documents (backslash paths)", () => {
    expect(stripOneDriveDocuments("C:\\Users\\manri\\OneDrive\\Documents\\Local Agent X"))
      .toBe("C:\\Users\\manri\\Documents\\Local Agent X");
  });

  it("handles forward-slash and trailing Documents", () => {
    expect(stripOneDriveDocuments("C:/Users/manri/OneDrive/Documents"))
      .toBe("C:/Users/manri/Documents");
  });

  it("is case-insensitive on the OneDrive segment", () => {
    expect(stripOneDriveDocuments("C:\\Users\\m\\onedrive\\Documents\\X"))
      .toBe("C:\\Users\\m\\Documents\\X");
  });

  it("leaves a non-OneDrive Documents path untouched", () => {
    const p = "C:\\Users\\manri\\Documents\\Local Agent X";
    expect(stripOneDriveDocuments(p)).toBe(p);
  });

  it("does NOT strip OneDrive when it isn't the Documents redirect (e.g. OneDrive\\Pictures)", () => {
    const p = "C:\\Users\\manri\\OneDrive\\Pictures\\foo";
    expect(stripOneDriveDocuments(p)).toBe(p);
  });
});

// macOS analogue: a workspace under a cloud-synced Documents gets its files
// evicted to dataless placeholders (blank generated media, broken atomic
// config writes), so it must relocate to local-only disk. isCloudStoragePath
// is the path-string half of detection (third-party File Providers + an
// already-resolved iCloud path); Apple's path-preserving Documents sync is
// caught separately by an inode-identity check.
describe("isCloudStoragePath", () => {
  it("matches a third-party File Provider path (~/Library/CloudStorage)", () => {
    expect(isCloudStoragePath("/Users/dad/Library/CloudStorage/OneDrive-Personal/Documents/Local Agent X"))
      .toBe(true);
  });

  it("matches a resolved iCloud CloudDocs path", () => {
    expect(isCloudStoragePath("/Users/dad/Library/Mobile Documents/com~apple~CloudDocs/Documents/Local Agent X"))
      .toBe(true);
  });

  it("leaves a plain local Documents path untouched", () => {
    expect(isCloudStoragePath("/Users/dad/Documents/Local Agent X")).toBe(false);
  });

  it("leaves the local-only ~/.lax workspace untouched", () => {
    expect(isCloudStoragePath("/Users/dad/.lax/workspace")).toBe(false);
  });
});

// Changing the workspace location in Settings must not strand the user's apps,
// images, and docs. migrateWorkspace moves them non-destructively (per-entry,
// merge dirs, never clobber); ensureWorkspaceLink runs it when the cwd link is
// retargeted to a new workspace at boot.
describe("migrateWorkspace (non-destructive merge)", () => {
  const temps: string[] = [];
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "ws-mig-")); temps.push(d); return d; };
  afterEach(() => { for (const d of temps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

  it("moves files from the old workspace into the new one", () => {
    const base = mk();
    const oldWs = join(base, "old"), newWs = join(base, "new");
    mkdirSync(join(oldWs, "apps", "demo"), { recursive: true });
    writeFileSync(join(oldWs, "apps", "demo", "index.html"), "<h1>hi</h1>");
    migrateWorkspace(oldWs, newWs);
    expect(readFileSync(join(newWs, "apps", "demo", "index.html"), "utf-8")).toBe("<h1>hi</h1>");
  });

  it("merges into an existing destination without clobbering its files", () => {
    const base = mk();
    const oldWs = join(base, "old"), newWs = join(base, "new");
    mkdirSync(join(oldWs, "apps"), { recursive: true });
    writeFileSync(join(oldWs, "apps", "a.txt"), "from-old");
    mkdirSync(join(newWs, "apps"), { recursive: true });
    writeFileSync(join(newWs, "apps", "a.txt"), "KEEP-new"); // collision
    writeFileSync(join(newWs, "apps", "b.txt"), "from-new");
    migrateWorkspace(oldWs, newWs);
    expect(readFileSync(join(newWs, "apps", "a.txt"), "utf-8")).toBe("KEEP-new"); // not clobbered
    expect(readFileSync(join(newWs, "apps", "b.txt"), "utf-8")).toBe("from-new"); // preserved
  });
});

describe("ensureWorkspaceLink retargets + migrates on a workspace change", () => {
  const temps: string[] = [];
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "ws-link-")); temps.push(d); return d; };
  afterEach(() => { for (const d of temps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

  it("relinks the cwd workspace to the new location AND migrates the old contents", () => {
    const base = mk();
    const oldWs = join(base, "old-workspace");
    const newWs = join(base, "new-workspace");
    const link = join(base, "cwd-workspace"); // stand-in for <cwd>/workspace
    mkdirSync(join(oldWs, "apps", "demo"), { recursive: true });
    writeFileSync(join(oldWs, "apps", "demo", "index.html"), "<h1>old</h1>");

    let linkable = true;
    try { symlinkSync(oldWs, link, process.platform === "win32" ? "junction" : "dir"); }
    catch { linkable = false; } // unprivileged POSIX symlink — skip assertions
    if (!linkable) return;

    ensureWorkspaceLink(newWs, link);

    expect(resolve(readlinkSync(link))).toBe(resolve(newWs));         // relinked
    expect(readFileSync(join(newWs, "apps", "demo", "index.html"), "utf-8")).toBe("<h1>old</h1>"); // migrated
  });
});
