import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallRollback } from "../scripts/installer/rollback.mjs";
import { createReporter } from "../scripts/installer/reporter.mjs";
import { runInstaller } from "../scripts/installer/orchestrator.mjs";
import { CAN_CREATE_DIRECTORY_LINK } from "../src/symlink-capabilities.test-helper.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "lax-install-rollback-"));
  roots.push(base);
  const installRoot = join(base, "install");
  const dataDirectory = join(base, "data");
  mkdirSync(join(installRoot, "dist"), { recursive: true });
  mkdirSync(join(installRoot, "workspace"), { recursive: true });
  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(installRoot, "dist", "index.js"), "verified-old");
  writeFileSync(join(installRoot, "workspace", "user.txt"), "keep-me");
  return { base, installRoot, dataDirectory };
}

describe("installer artifact rollback", () => {
  it("restores prior runtime artifacts without touching user workspace", () => {
    const f = fixture();
    mkdirSync(f.dataDirectory, { recursive: true });
    const previousCommit = "a".repeat(40);
    writeFileSync(join(f.dataDirectory, "installed-source.json"), JSON.stringify({ commit: previousCommit }));
    const transaction = createInstallRollback(f);
    transaction.begin();
    mkdirSync(join(f.installRoot, "dist"));
    writeFileSync(join(f.installRoot, "dist", "index.js"), "broken-new");
    writeFileSync(join(f.dataDirectory, "installed-source.json"), JSON.stringify({ commit: "b".repeat(40) }));
    expect(transaction.rollback("required build failed")).toMatchObject({ restored: true });
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
    expect(JSON.parse(readFileSync(join(f.dataDirectory, "installed-source.json"), "utf-8")).commit).toBe(previousCommit);
  });

  it("removes artifacts introduced by a failed fresh install", () => {
    const f = fixture();
    rmSync(join(f.installRoot, "dist"), { recursive: true });
    const transaction = createInstallRollback(f);
    transaction.begin();
    mkdirSync(join(f.installRoot, "dist"));
    writeFileSync(join(f.installRoot, "dist", "index.js"), "partial");
    transaction.rollback("failed");
    expect(existsSync(join(f.installRoot, "dist"))).toBe(false);
  });

  it("resumes an interrupted active transaction without discarding completed work", () => {
    const f = fixture();
    const first = createInstallRollback(f);
    first.begin();
    mkdirSync(join(f.installRoot, "dist"));
    writeFileSync(join(f.installRoot, "dist", "index.js"), "partial");
    const resumed = createInstallRollback(f);
    expect(resumed.reconcile().outcome).toBe("installer-transaction-resumed");
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("partial");
    resumed.rollback("later required failure");
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
    expect(createInstallRollback(f).reconcile().outcome).toBe("none");
  });

  it("retains a verified install if cleanup was interrupted", () => {
    const f = fixture();
    const transaction = createInstallRollback({ ...f, installerFault: (point: string) => {
      if (point === "after-verified") throw new Error("kill");
    } });
    transaction.begin();
    mkdirSync(join(f.installRoot, "dist"));
    writeFileSync(join(f.installRoot, "dist", "index.js"), "verified-new");
    expect(() => transaction.verified()).toThrow("kill");
    expect(createInstallRollback(f).reconcile().outcome).toBe("verified-install-retained");
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-new");
  });

  it("fails closed on corrupt or root-mismatched provenance", () => {
    const f = fixture();
    mkdirSync(join(f.dataDirectory, "install-rollback"), { recursive: true });
    const path = join(f.dataDirectory, "install-rollback", "transaction.json");
    writeFileSync(path, "{broken");
    expect(() => createInstallRollback(f).reconcile()).toThrow(/ambiguous provenance/);
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
    writeFileSync(path, JSON.stringify({ version: 1, status: "active", identity: { root: "C:\\other" }, artifacts: [] }));
    expect(() => createInstallRollback(f).reconcile()).toThrow(/ambiguous provenance/);
  });

  it("fails closed when package identity drifts before recovery", () => {
    const f = fixture();
    createInstallRollback(f).begin();
    writeFileSync(join(f.installRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));
    expect(() => createInstallRollback(f).reconcile()).toThrow(/package identity/);
  });

  it.each([
    ["empty", ""], ["root alias", "."], ["absolute", "C:\\outside"],
    ["traversal", "..\\outside"], ["dot alias", "dist\\."],
    ["case alias", "DIST"], ["parent-child alias", "dist\\child"],
  ])("rejects %s artifact paths before changing any byte", (_label, malicious) => {
    const f = fixture();
    const transaction = createInstallRollback(f);
    transaction.begin();
    const journalPath = join(f.dataDirectory, "install-rollback", "transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    journal.artifacts[0].relative = malicious;
    writeFileSync(journalPath, JSON.stringify(journal));
    const userBefore = readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8");
    expect(() => createInstallRollback(f).reconcile()).toThrow(/ambiguous provenance/);
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe(userBefore);
    expect(existsSync(f.installRoot)).toBe(true);
  });

  it.each(["duplicate", "partial"])("rejects an artifact %s set without mutation", (kind) => {
    const f = fixture();
    createInstallRollback(f).begin();
    const journalPath = join(f.dataDirectory, "install-rollback", "transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    if (kind === "duplicate") journal.artifacts[1] = { ...journal.artifacts[0] };
    else journal.artifacts.pop();
    writeFileSync(journalPath, JSON.stringify(journal));
    expect(() => createInstallRollback(f).reconcile()).toThrow(/ambiguous provenance/);
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("rejects a target junction escape without touching either tree", () => {
    const f = fixture();
    createInstallRollback(f).begin();
    const outside = join(f.base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "outside-safe");
    symlinkSync(outside, join(f.installRoot, "dist"), process.platform === "win32" ? "junction" : "dir");
    expect(() => createInstallRollback(f).reconcile()).toThrow(/ambiguous provenance/);
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("outside-safe");
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("rejects a backup junction escape without touching the install", () => {
    const f = fixture();
    createInstallRollback(f).begin();
    const outside = join(f.base, "outside-backup");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "outside-safe");
    const backup = join(f.dataDirectory, "install-rollback", "artifacts", "dist");
    rmSync(backup, { recursive: true });
    symlinkSync(outside, backup, process.platform === "win32" ? "junction" : "dir");
    expect(() => createInstallRollback(f).reconcile()).toThrow(/ambiguous provenance/);
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("outside-safe");
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK).each([
    "install parent", "install endpoint", "backup root parent", "backup artifact parent", "backup nested parent",
  ])("rejects a %s junction before backup moves any byte", (placement) => {
    const f = fixture();
    const outside = join(f.base, `outside-${placement.replaceAll(" ", "-")}`);
    mkdirSync(join(outside, "node_modules"), { recursive: true });
    writeFileSync(join(outside, "node_modules", "keep.txt"), "outside-runtime-safe");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    if (placement === "install parent") symlinkSync(outside, join(f.installRoot, "desktop"), linkType);
    if (placement === "install endpoint") {
      mkdirSync(join(f.installRoot, "desktop"));
      symlinkSync(join(outside, "node_modules"), join(f.installRoot, "desktop", "node_modules"), linkType);
    }
    if (placement === "backup root parent") {
      mkdirSync(f.dataDirectory, { recursive: true });
      symlinkSync(outside, join(f.dataDirectory, "install-rollback"), linkType);
    }
    if (placement === "backup artifact parent") {
      mkdirSync(join(f.dataDirectory, "install-rollback"), { recursive: true });
      symlinkSync(outside, join(f.dataDirectory, "install-rollback", "artifacts"), linkType);
    }
    if (placement === "backup nested parent") {
      mkdirSync(join(f.dataDirectory, "install-rollback", "artifacts"), { recursive: true });
      symlinkSync(outside, join(f.dataDirectory, "install-rollback", "artifacts", "desktop"), linkType);
    }
    expect(() => createInstallRollback(f).begin()).toThrow(/linked|ambiguous provenance/);
    expect(readFileSync(join(outside, "node_modules", "keep.txt"), "utf-8")).toBe("outside-runtime-safe");
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("rejects a dangling junction ancestor before backup", () => {
    const f = fixture();
    const vanished = join(f.base, "vanished");
    mkdirSync(vanished);
    symlinkSync(vanished, join(f.installRoot, "desktop"), process.platform === "win32" ? "junction" : "dir");
    rmSync(vanished, { recursive: true });
    expect(existsSync(join(f.installRoot, "desktop"))).toBe(false);
    expect(() => createInstallRollback(f).begin()).toThrow(/linked/);
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK).each([
    "after-backup-journal", "after-backup", "before-restore", "after-restore", "after-verified",
  ])("revalidates linked ancestors after the %s fault boundary", (faultPoint) => {
    const f = fixture();
    const outside = join(f.base, `swap-${faultPoint}`);
    mkdirSync(join(outside, "node_modules"), { recursive: true });
    writeFileSync(join(outside, "node_modules", "keep.txt"), "outside-safe");
    let swapped = false;
    const swap = (point: string) => {
      if (point !== faultPoint || swapped) return;
      swapped = true;
      symlinkSync(outside, join(f.installRoot, "desktop"), process.platform === "win32" ? "junction" : "dir");
    };
    const transaction = createInstallRollback({ ...f, installerFault: swap });
    if (faultPoint.startsWith("after-backup")) {
      expect(() => transaction.begin()).toThrow(/paths changed|linked/);
    } else {
      transaction.begin();
      if (faultPoint === "after-verified") expect(() => transaction.verified()).toThrow(/paths changed|linked/);
      else expect(() => transaction.rollback("required failure")).toThrow(/paths changed|linked/);
    }
    expect(swapped).toBe(true);
    expect(readFileSync(join(outside, "node_modules", "keep.txt"), "utf-8")).toBe("outside-safe");
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
  });

  it("keeps restore retryable across a kill at the restore boundary", () => {
    const f = fixture();
    const transaction = createInstallRollback({ ...f, installerFault: (point: string) => {
      if (point === "before-restore") throw new Error("kill");
    } });
    transaction.begin();
    mkdirSync(join(f.installRoot, "dist"));
    expect(() => transaction.rollback("failed")).toThrow("kill");
    expect(createInstallRollback(f).reconcile().restored).toBe(true);
  });

  it("restores an interrupted backup before any installer step can run", () => {
    const f = fixture();
    const transaction = createInstallRollback({ ...f, installerFault: (point: string) => {
      if (point === "after-backup-journal") throw new Error("kill");
    } });
    expect(() => transaction.begin()).toThrow("kill");
    expect(createInstallRollback(f).reconcile().outcome).toBe("prior-installation-restored");
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
  });

  it("rolls back required failure through the real reporter lifecycle", async () => {
    const f = fixture();
    const reporter = createReporter({ ipcMode: true, stdout: { write: () => true } as NodeJS.WriteStream,
      exit: (code: number) => { throw new Error(`exit:${code}`); } });
    await expect(runInstaller({ ...f, reporter, platform: "linux", selections: {}, verifyInstallStep: () => "absent" }, {
      prerequisites: async () => {},
      core: async () => {
        expect(reporter.step("build")).toBe(true);
        mkdirSync(join(f.installRoot, "dist"));
        writeFileSync(join(f.installRoot, "dist", "index.js"), "bad");
        reporter.fail("build failed");
      },
      posixShell: async () => {}, desktop: async () => ({}), persist: () => true,
    })).rejects.toThrow("exit:1");
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
  });

  it("does not roll back optional degradation", async () => {
    const f = fixture();
    const reporter = createReporter({ ipcMode: true, stdout: { write: () => true } as NodeJS.WriteStream });
    const failure = vi.fn();
    reporter.attachRequiredFailure(failure);
    expect(reporter.step("ollama")).toBe(true);
    reporter.fail("offline");
    expect(failure).not.toHaveBeenCalled();
    expect(reporter.degraded).toEqual([{ step: "ollama", message: "offline" }]);
  });
});
