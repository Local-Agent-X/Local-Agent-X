import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUninstallRegistration,
  buildRegistryScript,
  planRegistration,
  readInstalledVersion,
  stableUninstallerPath,
  UNINSTALL_KEY_PATH,
} from "../scripts/installer/uninstall-registration.mjs";

// Regression cover for the class of bug that made an installed app impossible
// to remove from Windows Settings:
//
//   The uninstaller was generated INTO the source tree at install time, and the
//   registry entry pointed at it. Rolling updates replace that tree wholesale,
//   so the script disappeared and "Uninstall" ran `powershell -File <missing>`,
//   which exits instantly - a Settings row that did nothing, with no visible
//   error. DisplayVersion rotted the same way (frozen at first install), and
//   the script and packaged installers each registered a row with no knowledge
//   of the other, so a machine that had seen both showed two.
//
// Every test here pins one of those failures shut.

function makeSourceTree(root: string, opts: { version?: string; git?: boolean } = {}) {
  mkdirSync(join(root, "scripts", "uninstall"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "local-agent-x", version: opts.version ?? "1.2.3" }));
  writeFileSync(join(root, "scripts", "uninstall", "lax-uninstall.ps1"), "# uninstaller\n");
  writeFileSync(join(root, "scripts", "uninstall", "lax-uninstall.sh"), "# uninstaller\n");
  if (opts.git) mkdirSync(join(root, ".git"), { recursive: true });
}

describe("uninstall registration", () => {
  let tmp: string;
  let sourceRoot: string;
  let home: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lax-uninstall-"));
    sourceRoot = join(tmp, "install");
    home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    makeSourceTree(sourceRoot);
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  describe("the uninstaller must survive a tree swap", () => {
    it("stages the uninstaller OUTSIDE the source tree", () => {
      const target = stableUninstallerPath("win32", home);
      expect(target.startsWith(sourceRoot)).toBe(false);
      expect(target).toBe(join(home, ".lax", "uninstall", "lax-uninstall.ps1"));
    });

    it("never points UninstallString into the tree an update replaces", () => {
      const plan = planRegistration({ sourceRoot, platform: "win32", home, env: {} });
      expect(plan.action).toBe("register");
      // The original bug in one assertion: the command Windows runs must not
      // live inside the directory a rolling update deletes and recreates.
      expect(plan.values.UninstallString).not.toContain(sourceRoot);
      expect(plan.values.UninstallString).toContain(join(home, ".lax", "uninstall"));
    });

    it("re-materialises the uninstaller after it is deleted", () => {
      const spawnSync = () => ({ status: 0 }) as never;
      const staged = stableUninstallerPath("win32", home);

      assertUninstallRegistration({ sourceRoot, platform: "win32", home, env: {}, spawnSync });
      expect(existsSync(staged)).toBe(true);

      // Simulate whatever ate it - an update, a partial uninstall, a user.
      rmSync(staged);
      expect(existsSync(staged)).toBe(false);

      // The next boot puts it back. This is what makes the dead-entry state
      // self-correcting rather than permanent.
      const result = assertUninstallRegistration({ sourceRoot, platform: "win32", home, env: {}, spawnSync });
      expect(existsSync(staged)).toBe(true);
      expect(result.staged).toBe(true);
      expect(result.ok).toBe(true);
    });

    it("is idempotent - re-asserting changes nothing about the outcome", () => {
      const spawnSync = () => ({ status: 0 }) as never;
      const a = assertUninstallRegistration({ sourceRoot, platform: "win32", home, env: {}, spawnSync });
      const b = assertUninstallRegistration({ sourceRoot, platform: "win32", home, env: {}, spawnSync });
      expect(b).toEqual(a);
    });
  });

  describe("the advertised version must not go stale", () => {
    it("reads the version from the tree at assert time, not from a cached value", () => {
      const first = planRegistration({ sourceRoot, platform: "win32", home, env: {} });
      expect(first.values.DisplayVersion).toBe("1.2.3");

      // A rolling update moves the tree forward without touching the registry.
      writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ name: "local-agent-x", version: "9.9.9" }));

      const second = planRegistration({ sourceRoot, platform: "win32", home, env: {} });
      expect(second.values.DisplayVersion).toBe("9.9.9");
    });

    it("falls back to 0.0.0 rather than throwing on an unreadable package.json", () => {
      writeFileSync(join(sourceRoot, "package.json"), "{ not json");
      expect(readInstalledVersion(sourceRoot)).toBe("0.0.0");
    });
  });

  describe("exactly one Add/Remove entry owns the machine", () => {
    it("retires our key when a packaged install is present", () => {
      const localAppData = join(tmp, "LocalAppData");
      const packagedDir = join(localAppData, "Programs", "local-agent-x-desktop");
      mkdirSync(packagedDir, { recursive: true });
      writeFileSync(join(packagedDir, "Uninstall LocalAgentX.exe"), "");

      const plan = planRegistration({ sourceRoot, platform: "win32", home, env: { LOCALAPPDATA: localAppData } });
      expect(plan.action).toBe("retire");
      expect(plan.retireKey).toBe(UNINSTALL_KEY_PATH);
      expect(buildRegistryScript(plan)).toContain("Remove-Item");
    });

    it("still stages the script when retiring, so a manual escape hatch exists", () => {
      const localAppData = join(tmp, "LocalAppData");
      const packagedDir = join(localAppData, "Programs", "local-agent-x-desktop");
      mkdirSync(packagedDir, { recursive: true });
      writeFileSync(join(packagedDir, "Uninstall LocalAgentX.exe"), "");

      const result = assertUninstallRegistration({
        sourceRoot, platform: "win32", home,
        env: { LOCALAPPDATA: localAppData },
        spawnSync: () => ({ status: 0 }) as never,
      });
      expect(result.action).toBe("retire");
      expect(existsSync(stableUninstallerPath("win32", home))).toBe(true);
    });

    it("registers our own key when no packaged install exists", () => {
      const plan = planRegistration({ sourceRoot, platform: "win32", home, env: { LOCALAPPDATA: join(tmp, "empty") } });
      expect(plan.action).toBe("register");
      expect(plan.keyPath).toBe(UNINSTALL_KEY_PATH);
    });
  });

  describe("a developer's checkout is not a product install", () => {
    it("refuses to register a git checkout", () => {
      const clone = join(tmp, "clone");
      makeSourceTree(clone, { git: true });
      const plan = planRegistration({ sourceRoot: clone, platform: "win32", home, env: {} });
      expect(plan.action).toBe("skip");
      expect(plan.reason).toMatch(/git checkout/);
    });

    it("writes nothing at all for a git checkout", () => {
      const clone = join(tmp, "clone");
      makeSourceTree(clone, { git: true });
      let spawned = false;
      const result = assertUninstallRegistration({
        sourceRoot: clone, platform: "win32", home, env: {},
        spawnSync: () => { spawned = true; return { status: 0 } as never; },
      });
      expect(result.action).toBe("skip");
      expect(spawned).toBe(false);
      expect(existsSync(stableUninstallerPath("win32", home))).toBe(false);
    });
  });

  describe("registry script generation", () => {
    it("escapes single quotes so a path cannot break out of the PowerShell literal", () => {
      const plan = planRegistration({ sourceRoot, platform: "win32", home, env: {} });
      plan.values.InstallLocation = "C:\\it's\\here";
      const script = buildRegistryScript(plan);
      expect(script).toContain("'C:\\it''s\\here'");
    });

    it("offers a silent uninstall string, so unattended removal is possible", () => {
      const plan = planRegistration({ sourceRoot, platform: "win32", home, env: {} });
      expect(plan.values.QuietUninstallString).toContain("-Yes");
    });
  });

  describe("failure containment", () => {
    it("reports failure instead of throwing when the registry write fails", () => {
      const result = assertUninstallRegistration({
        sourceRoot, platform: "win32", home, env: {},
        spawnSync: () => ({ status: 1 }) as never,
      });
      expect(result.ok).toBe(false);
      // Still staged: the manual path must work even when the row does not.
      expect(existsSync(stableUninstallerPath("win32", home))).toBe(true);
    });

    it("stages without touching the registry on non-Windows", () => {
      let spawned = false;
      const result = assertUninstallRegistration({
        sourceRoot, platform: "darwin", home, env: {},
        spawnSync: () => { spawned = true; return { status: 0 } as never; },
      });
      expect(result.action).toBe("stage-only");
      expect(spawned).toBe(false);
      expect(existsSync(stableUninstallerPath("darwin", home))).toBe(true);
    });
  });
});
