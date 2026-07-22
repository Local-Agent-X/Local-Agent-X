import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallRollback } from "../scripts/installer/rollback.mjs";
import { installCheckpointPath } from "../scripts/installer/checkpoint.mjs";
import { installTransactionPath } from "../scripts/installer/install-journal.mjs";
import { installerContract, stepIntent } from "../scripts/installer/contract.mjs";
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

  it("copies durably before removing source when a rollback move crosses volumes", () => {
    const f = fixture();
    const installerRename = vi.fn(() => { throw Object.assign(new Error("cross-volume"), { code: "EXDEV" }); });
    const transaction = createInstallRollback({ ...f, installerRename });
    transaction.begin();
    expect(existsSync(join(f.installRoot, "dist"))).toBe(false);
    expect(readFileSync(join(f.dataDirectory, "install-rollback", "artifacts", "dist", "index.js"), "utf-8"))
      .toBe("verified-old");
    mkdirSync(join(f.installRoot, "dist"));
    writeFileSync(join(f.installRoot, "dist", "index.js"), "broken-new");
    expect(transaction.rollback("required build failed")).toMatchObject({ restored: true });
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-old");
    expect(existsSync(join(f.installRoot, "dist.installer-copy"))).toBe(false);
    expect(installerRename).toHaveBeenCalledTimes(2);
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
    expect(createInstallRollback(f).reconcile().outcome).toBe("prior-installation-restored");
    expect(existsSync(installTransactionPath(f.dataDirectory))).toBe(true);
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

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK).each(["install", "data"])(
    "rejects a linked %s base even when every rollback artifact is absent", (baseKind) => {
      const f = fixture();
      const target = baseKind === "install" ? f.installRoot : f.dataDirectory;
      if (baseKind === "install") rmSync(f.installRoot, { recursive: true });
      const outside = join(f.base, `linked-${baseKind}-base`);
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "outside-safe");
      symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
      expect(() => createInstallRollback(f).begin()).toThrow(/trusted rollback base|linked/i);
      expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("outside-safe");
    },
  );

  it.each(["install", "data"])("rejects replacement of the bound %s base", (baseKind) => {
    const f = fixture();
    const transaction = createInstallRollback(f);
    transaction.begin();
    const target = baseKind === "install" ? f.installRoot : f.dataDirectory;
    const original = join(f.base, `original-${baseKind}`);
    renameSync(target, original);
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "replacement-safe");
    expect(() => transaction.rollback("required failure")).toThrow(/trusted base identity changed/i);
    expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("replacement-safe");
    if (baseKind === "install") {
      expect(readFileSync(join(original, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
    } else {
      expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
    }
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK).each([
    "after-backup-journal", "after-backup", "before-restore", "after-restore", "after-verified",
  ])("rejects an install-base swap after the %s fault boundary", (faultPoint) => {
    const f = fixture();
    const original = join(f.base, `original-install-${faultPoint}`);
    const outside = join(f.base, `outside-install-${faultPoint}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "outside-safe");
    let swapped = false;
    const transaction = createInstallRollback({ ...f, installerFault: (point: string) => {
      if (point !== faultPoint || swapped) return;
      swapped = true;
      renameSync(f.installRoot, original);
      symlinkSync(outside, f.installRoot, process.platform === "win32" ? "junction" : "dir");
    } });
    if (faultPoint.startsWith("after-backup")) {
      expect(() => transaction.begin()).toThrow(/trusted base identity changed|linked/i);
    } else {
      transaction.begin();
      if (faultPoint === "after-verified") expect(() => transaction.verified()).toThrow(/trusted base identity changed|linked/i);
      else expect(() => transaction.rollback("required failure")).toThrow(/trusted base identity changed|linked/i);
    }
    expect(swapped).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("outside-safe");
    expect(readFileSync(join(original, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
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
    expect(existsSync(installTransactionPath(f.dataDirectory))).toBe(true);
    const recovered = createInstallRollback(f);
    expect(recovered.reconcile().restored).toBe(true);
    expect(existsSync(installTransactionPath(f.dataDirectory))).toBe(true);
    recovered.begin();
    expect(JSON.parse(readFileSync(installTransactionPath(f.dataDirectory), "utf-8")).status).toBe("active");
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

  it("clears a rolled-back in-flight checkpoint so the installer can retry", async () => {
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
    const recoveredJournal = JSON.parse(readFileSync(installTransactionPath(f.dataDirectory), "utf-8"));
    expect(recoveredJournal.status).toBe("restored");
    expect(recoveredJournal.steps.inFlight).toBe(null);

    const retryReporter = createReporter({ ipcMode: true, stdout: { write: () => true } as NodeJS.WriteStream });
    await runInstaller({ ...f, reporter: retryReporter, platform: "linux", selections: {}, verifyInstallStep: () => "absent" }, {
      prerequisites: async () => {},
      core: async () => {
        expect(retryReporter.step("build")).toBe(true);
        mkdirSync(join(f.installRoot, "dist"));
        writeFileSync(join(f.installRoot, "dist", "index.js"), "verified-new");
        retryReporter.stepDone("build");
      },
      posixShell: async () => {}, desktop: async () => ({}), persist: () => true,
    });
    expect(readFileSync(join(f.installRoot, "dist", "index.js"), "utf-8")).toBe("verified-new");
  });

  it("migrates a valid legacy checkpoint into the rollback journal atomically", async () => {
    const f = fixture();
    mkdirSync(f.dataDirectory, { recursive: true });
    const contract = installerContract("linux", {});
    writeFileSync(installCheckpointPath(f.dataDirectory), JSON.stringify({
      version: 1, contract,
      completed: [{ id: "node", intent: stepIntent(contract, "node") }],
      inFlight: null, degraded: [], outputs: {},
    }));
    const reporter = createReporter({ ipcMode: true, stdout: { write: () => true } as NodeJS.WriteStream });
    await expect(runInstaller({
      ...f, reporter, platform: "linux", selections: {}, verifyInstallStep: (id: string) => id === "node" ? "present" : "absent",
    }, {
      prerequisites: async () => { expect(reporter.step("node")).toBe(false); },
      core: async () => { throw new Error("kill-after-migration"); },
      posixShell: async () => {}, desktop: async () => ({}), persist: () => true,
    })).rejects.toThrow("kill-after-migration");
    expect(existsSync(join(f.dataDirectory, "install-checkpoint.json"))).toBe(false);
    const journal = JSON.parse(readFileSync(installTransactionPath(f.dataDirectory), "utf-8"));
    expect(journal.version).toBe(2);
    expect(journal.steps.completed.map((item: { id: string }) => item.id)).toContain("node");
  });

  it("fails closed when legacy and unified step state conflict", () => {
    const f = fixture();
    createInstallRollback(f).begin();
    const contract = installerContract("linux", {});
    writeFileSync(join(f.dataDirectory, "install-checkpoint.json"), JSON.stringify({
      version: 1, contract, completed: [{ id: "node", intent: "different" }], inFlight: null, degraded: [], outputs: {},
    }));
    expect(() => createInstallRollback(f).reconcile()).toThrow(/conflicts with the unified/i);
    expect(readFileSync(join(f.installRoot, "workspace", "user.txt"), "utf-8")).toBe("keep-me");
  });

  it("upgrades an interrupted version-one rollback journal with its matching checkpoint", () => {
    const f = fixture();
    createInstallRollback(f).begin();
    const journalPath = installTransactionPath(f.dataDirectory);
    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    const legacy = { version: 1, ...journal.steps };
    journal.version = 1;
    delete journal.steps;
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(f.dataDirectory, "install-checkpoint.json"), JSON.stringify(legacy));
    expect(createInstallRollback(f).reconcile().outcome).toBe("installer-transaction-resumed");
    const migrated = JSON.parse(readFileSync(journalPath, "utf-8"));
    expect(migrated.version).toBe(2);
    const { version: _version, ...expectedSteps } = legacy;
    expect(migrated.steps).toEqual(expectedSteps);
    expect(existsSync(join(f.dataDirectory, "install-checkpoint.json"))).toBe(false);
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
