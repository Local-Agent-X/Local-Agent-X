import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripOneDriveDocuments, isCloudStoragePath, migrateWorkspace, ensureWorkspaceLink } from "./workspace/lifecycle.js";
import { loadConfig } from "./config.js";

describe("browser identity isolation config migration", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let configPath: string;

  beforeAll(() => {
    previousDataDir = process.env.LAX_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "browser-isolation-config-"));
    process.env.LAX_DATA_DIR = dataDir;
    configPath = join(dataDir, "config.json");
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeConfig(browser: Record<string, unknown>): void {
    writeFileSync(configPath, JSON.stringify({
      authToken: "test-token",
      workspace: resolve("workspace"),
      sandboxModeMigrated: true,
      ...browser,
    }), "utf-8");
  }

  it("defaults fresh installs to per-session browser identity isolation", () => {
    writeConfig({});

    const config = loadConfig();

    expect(config.browserPerSessionContext).toBe(true);
    expect(config.browserPerSessionContextMigrated).toBe(true);
  });

  it("upgrades the old untouched shared-context default once", () => {
    writeConfig({ browserPerSessionContext: false });

    expect(loadConfig().browserPerSessionContext).toBe(true);
    const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(persisted.browserPerSessionContext).toBe(true);
    expect(persisted.browserPerSessionContextMigrated).toBe(true);
  });

  it("does not persist environment overrides while migrating the browser default", () => {
    writeConfig({
      authToken: "disk-auth-token",
      openaiApiKey: "disk-provider-key",
      model: "disk-model",
      browserPerSessionContext: false,
    });
    const previous = {
      authToken: process.env.LAX_AUTH_TOKEN,
      openaiApiKey: process.env.OPENAI_API_KEY,
      model: process.env.LAX_MODEL,
    };
    process.env.LAX_AUTH_TOKEN = "env-auth-token";
    process.env.OPENAI_API_KEY = "env-provider-key";
    process.env.LAX_MODEL = "env-model";

    try {
      const runtime = loadConfig();
      expect(runtime.authToken).toBe("env-auth-token");
      expect(runtime.openaiApiKey).toBe("env-provider-key");
      expect(runtime.model).toBe("env-model");

      const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      expect(persisted.authToken).toBe("disk-auth-token");
      expect(persisted.openaiApiKey).toBe("disk-provider-key");
      expect(persisted.model).toBe("disk-model");
      expect(persisted.browserPerSessionContext).toBe(true);
      expect(persisted.browserPerSessionContextMigrated).toBe(true);
    } finally {
      if (previous.authToken === undefined) delete process.env.LAX_AUTH_TOKEN;
      else process.env.LAX_AUTH_TOKEN = previous.authToken;
      if (previous.openaiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous.openaiApiKey;
      if (previous.model === undefined) delete process.env.LAX_MODEL;
      else process.env.LAX_MODEL = previous.model;
    }
  });

  it("preserves an explicit shared-context continuity choice", () => {
    writeConfig({
      browserPerSessionContext: false,
      browserPerSessionContextMigrated: true,
    });

    expect(loadConfig().browserPerSessionContext).toBe(false);
  });
});

// Regression: on Windows with OneDrive "Known Folder Move", the agent
// workspace was being placed under ...\OneDrive\Documents\Local Agent X, where
// the sync client locks files mid-write and breaks the atomic config rename.
// The workspace must map back to the real on-disk Documents.
describe("stripOneDriveDocuments", () => {
  it("drops the OneDrive segment before Documents (backslash paths)", () => {
    expect(stripOneDriveDocuments("C:\\Users\\alice\\OneDrive\\Documents\\Local Agent X"))
      .toBe("C:\\Users\\alice\\Documents\\Local Agent X");
  });

  it("handles forward-slash and trailing Documents", () => {
    expect(stripOneDriveDocuments("C:/Users/alice/OneDrive/Documents"))
      .toBe("C:/Users/alice/Documents");
  });

  it("is case-insensitive on the OneDrive segment", () => {
    expect(stripOneDriveDocuments("C:\\Users\\m\\onedrive\\Documents\\X"))
      .toBe("C:\\Users\\m\\Documents\\X");
  });

  it("leaves a non-OneDrive Documents path untouched", () => {
    const p = "C:\\Users\\alice\\Documents\\Local Agent X";
    expect(stripOneDriveDocuments(p)).toBe(p);
  });

  it("does NOT strip OneDrive when it isn't the Documents redirect (e.g. OneDrive\\Pictures)", () => {
    const p = "C:\\Users\\alice\\OneDrive\\Pictures\\foo";
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
    expect(isCloudStoragePath("/Users/dev/Library/CloudStorage/OneDrive-Personal/Documents/Local Agent X"))
      .toBe(true);
  });

  it("matches a resolved iCloud CloudDocs path", () => {
    expect(isCloudStoragePath("/Users/dev/Library/Mobile Documents/com~apple~CloudDocs/Documents/Local Agent X"))
      .toBe(true);
  });

  it("leaves a plain local Documents path untouched", () => {
    expect(isCloudStoragePath("/Users/dev/Documents/Local Agent X")).toBe(false);
  });

  it("leaves the local-only ~/.lax workspace untouched", () => {
    expect(isCloudStoragePath("/Users/dev/.lax/workspace")).toBe(false);
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
