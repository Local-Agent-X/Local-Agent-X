// browseWorkspaceFolder — one workspace folder for the phone's file explorer
// (2026-10-24): what it lists, and what it never lists or reaches.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseWorkspaceFolder } from "./workspace-files.js";

let root: string;
let ws: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-browse-"));
  ws = join(root, "workspace");
  mkdirSync(join(ws, "resume-agency"), { recursive: true });
  mkdirSync(join(ws, "apps", "shop", "node_modules"), { recursive: true });
  writeFileSync(join(ws, "resume-agency", "resume.pdf"), "pdf");
  writeFileSync(join(ws, "loogle.html"), "<html>");
  writeFileSync(join(ws, ".hidden"), "x");
  writeFileSync(join(ws, "apps", "shop", ".env"), "SECRET=1");
  writeFileSync(join(ws, "apps", "shop", "index.html"), "<html>");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "private.txt"), "mine");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("browseWorkspaceFolder", () => {
  it("lists the top folder: folders first, then files, without dot-files", () => {
    const listing = browseWorkspaceFolder(ws, "")!;
    expect(listing.dir).toBe("");
    expect(listing.entries.map((e) => `${e.kind}:${e.path}`)).toEqual(["dir:apps", "dir:resume-agency", "file:loogle.html"]);
  });

  it("lists a nested folder with workspace paths, never node_modules or a credential file", () => {
    const listing = browseWorkspaceFolder(ws, "apps/shop")!;
    expect(listing.dir).toBe("apps/shop");
    expect(listing.entries.map((e) => e.path)).toEqual(["apps/shop/index.html"]);
    expect(browseWorkspaceFolder(ws, "resume-agency")!.entries[0]).toMatchObject({ name: "resume.pdf", kind: "file", size: 3 });
  });

  it("refuses a folder outside the workspace, a file, and a missing folder", () => {
    expect(browseWorkspaceFolder(ws, "../outside")).toBeNull();
    expect(browseWorkspaceFolder(ws, "loogle.html")).toBeNull();
    expect(browseWorkspaceFolder(ws, "nope")).toBeNull();
  });

  it("neither lists nor follows a link planted in the workspace", () => {
    symlinkSync(join(root, "outside"), join(ws, "escape"), "junction");
    expect(browseWorkspaceFolder(ws, "")!.entries.map((e) => e.name)).not.toContain("escape");
    expect(browseWorkspaceFolder(ws, "escape")).toBeNull();
  });
});
