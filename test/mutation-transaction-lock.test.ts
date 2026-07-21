import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createReporter } from "../scripts/installer/reporter.mjs";
import { runInstaller } from "../scripts/installer/orchestrator.mjs";
import { runCoreSteps } from "../scripts/installer/core-steps.mjs";
import { verifyInstallStep } from "../scripts/installer/step-verification.mjs";
import { killProbe } from "../src/self-edit/sandbox-gates.js";
import { bindInstallerDataRoot } from "../scripts/installer/data-root.mjs";
import { writeDurableJson } from "../scripts/installer/checkpoint.mjs";
import {
  acquireMutationLock, mutationLockHeldByLiveProcess, releaseMutationLock,
} from "../scripts/installer/transaction-lock.mjs";
import { CAN_CREATE_DIRECTORY_LINK } from "../src/symlink-capabilities.test-helper.js";
import { CAN_CREATE_FILE_SYMLINK } from "../src/symlink-capabilities.test-helper.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const childScript = fileURLToPath(new URL("./fixtures/mutation-lock-child.mjs", import.meta.url));

afterEach(() => {
  children.splice(0).forEach((child) => child.kill());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function launch(dataDirectory: string, barrier: string): ChildProcess {
  const child = spawn(process.execPath, [childScript, dataDirectory, barrier], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return child;
}

function result(child: ChildProcess): Promise<{ acquired: boolean; pid: number }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("mutation lock child timed out")), 10_000);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/).find(Boolean);
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.once("error", reject);
  });
}

function reporter() {
  return createReporter({
    ipcMode: true,
    stdout: { write: () => true } as NodeJS.WriteStream,
    exit: (code: number) => { throw new Error(`exit:${code}`); },
  });
}

const stages = {
  prerequisites: async () => {}, core: async () => {}, posixShell: async () => {},
  desktop: async () => ({}), persist: () => true,
};

describe("shared installation mutation lease", () => {
  it("locks a fresh data root without creating it before the installer transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-mutation-fresh-root-"));
    roots.push(root);
    const dataDirectory = join(root, "not-created-yet");
    const lock = await acquireMutationLock(dataDirectory, { task: "fresh install" });
    expect(lock.acquired).toBe(true);
    expect(existsSync(dataDirectory)).toBe(false);
    await releaseMutationLock(lock);
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("makes the boot sweep fail closed on a linked data root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-mutation-linked-root-"));
    roots.push(root);
    const outside = join(root, "outside");
    const linked = join(root, "linked");
    mkdirSync(outside);
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    expect(await mutationLockHeldByLiveProcess(linked)).toBe(true);
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("does not write or delete through a data-root swap", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-mutation-root-swap-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const parked = join(root, "parked");
    const outside = join(root, "outside");
    mkdirSync(dataDirectory);
    mkdirSync(outside);
    const lock = await acquireMutationLock(dataDirectory, { task: "swap safety" });
    expect(lock.acquired).toBe(true);
    renameSync(dataDirectory, parked);
    symlinkSync(outside, dataDirectory, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(outside, "sentinel"), "keep");
    await releaseMutationLock(lock);
    expect(existsSync(join(outside, "sentinel"))).toBe(true);
  });

  it("allows only one synchronized reclaimer of a dead legacy holder", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lax-mutation-race-"));
    roots.push(dataDirectory);
    writeFileSync(join(dataDirectory, "self-edit-sandbox.lock"), JSON.stringify({
      pid: 2_147_483_646, startedAt: "2020-01-01T00:00:00.000Z", nonce: "dead",
    }));
    const barrier = join(dataDirectory, "start");
    const first = launch(dataDirectory, barrier);
    const second = launch(dataDirectory, barrier);
    const firstResult = result(first);
    const secondResult = result(second);
    writeFileSync(barrier, "go");
    const outcomes = await Promise.all([firstResult, secondResult]);
    expect(outcomes.filter((item) => item.acquired)).toHaveLength(1);
  });

  it("blocks the installer while another mutation path owns the lease", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lax-mutation-cross-path-"));
    roots.push(dataDirectory);
    const barrier = join(dataDirectory, "start");
    const child = launch(dataDirectory, barrier);
    const childResult = result(child);
    writeFileSync(barrier, "go");
    expect((await childResult).acquired).toBe(true);
    await expect(runInstaller({
      reporter: reporter(), platform: "linux", dataDirectory, selections: {}, verifyInstallStep: () => "absent",
    }, stages)).rejects.toThrow("exit:1");
  });

  it("uses LAX_DATA_DIR as the installer lock root when context has no explicit directory", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lax-mutation-env-root-"));
    roots.push(dataDirectory);
    const owner = await acquireMutationLock(dataDirectory, { task: "runtime mutation" });
    expect(owner.acquired).toBe(true);
    await expect(runInstaller({
      reporter: reporter(), platform: "linux", env: { LAX_DATA_DIR: dataDirectory }, selections: {}, verifyInstallStep: () => "absent",
    }, stages)).rejects.toThrow("exit:1");
    await releaseMutationLock(owner);
  });

  it("writes and verifies installer state only in the canonical custom data root", async () => {
    const home = mkdtempSync(join(tmpdir(), "lax-mutation-custom-home-"));
    roots.push(home);
    const dataDirectory = join(home, "custom-data");
    const completed: string[] = [];
    const context = {
      dataDirectory,
      homeDirectory: home,
      wantOllamaMemoryModel: false,
      reporter: {
        step: (id: string) => ["settings", "config"].includes(id),
        resumedStepResult: () => undefined,
        stepDone: (id: string) => { completed.push(id); },
        ok: () => {},
      },
      processes: {},
    };
    bindInstallerDataRoot(context);
    await runCoreSteps(context);
    expect(completed).toEqual(["settings", "config"]);
    expect(existsSync(join(dataDirectory, "settings.json"))).toBe(true);
    expect(existsSync(join(dataDirectory, "config.json"))).toBe(true);
    expect(existsSync(join(home, ".lax"))).toBe(false);
    expect(verifyInstallStep("settings", context)).toBe("present");
    expect(verifyInstallStep("config", context)).toBe("present");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("blocks an actual installer state write after a data-root swap", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-mutation-write-swap-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const parked = join(root, "parked");
    const outside = join(root, "outside");
    mkdirSync(dataDirectory);
    mkdirSync(outside);
    let swapped = false;
    const context = {
      dataDirectory,
      wantOllamaMemoryModel: false,
      reporter: {
        step: (id: string) => id === "settings",
        resumedStepResult: () => undefined,
        stepDone: () => {},
        ok: () => {},
      },
      processes: {},
      installerDataRootFault: () => {
        if (swapped) return;
        swapped = true;
        renameSync(dataDirectory, parked);
        symlinkSync(outside, dataDirectory, process.platform === "win32" ? "junction" : "dir");
      },
    };
    bindInstallerDataRoot(context);
    await expect(runCoreSteps(context)).rejects.toThrow(/identity changed|linked/i);
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
  });

  it("rejects an existing installer state file with another hard-link name", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-mutation-hardlink-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const outside = join(root, "outside.json");
    mkdirSync(dataDirectory);
    writeFileSync(outside, "keep");
    linkSync(outside, join(dataDirectory, "config.json"));
    const context = {
      dataDirectory,
      wantOllamaMemoryModel: false,
      reporter: {
        step: (id: string) => id === "config",
        resumedStepResult: () => undefined,
        stepDone: () => {},
        ok: () => {},
      },
      processes: {},
    };
    bindInstallerDataRoot(context);
    await expect(runCoreSteps(context)).rejects.toThrow(/linked|escaped/i);
    expect(readFileSync(outside, "utf-8")).toBe("keep");
  });

  it("rejects a hard link inserted after settings mutation validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-mutation-child-hardlink-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const outside = join(root, "outside.json");
    mkdirSync(dataDirectory);
    writeFileSync(outside, "keep");
    let swapped = false;
    const context = {
      dataDirectory,
      wantOllamaMemoryModel: false,
      reporter: {
        step: (id: string) => id === "settings",
        resumedStepResult: () => undefined,
        stepDone: () => {},
        ok: () => {},
      },
      processes: {},
      installerDataRootFault: (point: string) => {
        if (point !== "before-publication" || swapped) return;
        swapped = true;
        linkSync(outside, join(dataDirectory, "settings.json"));
      },
    };
    bindInstallerDataRoot(context);
    await expect(runCoreSteps(context)).rejects.toThrow(/linked|regular file/i);
    expect(readFileSync(outside, "utf-8")).toBe("keep");
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("rejects a symlink inserted after config mutation validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-mutation-child-symlink-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const configFile = join(dataDirectory, "config.json");
    const outside = join(root, "outside.json");
    mkdirSync(dataDirectory);
    writeFileSync(configFile, JSON.stringify({ authToken: "existing-token" }));
    writeFileSync(outside, JSON.stringify({ keep: true }));
    let swapped = false;
    const context = {
      dataDirectory,
      wantOllamaMemoryModel: false,
      reporter: {
        step: (id: string) => id === "config",
        resumedStepResult: () => undefined,
        stepDone: () => {},
        ok: () => {},
      },
      processes: {},
      installerDataRootFault: (point: string) => {
        if (point !== "before-publication" || swapped) return;
        swapped = true;
        unlinkSync(configFile);
        symlinkSync(outside, configFile, "file");
      },
    };
    bindInstallerDataRoot(context);
    await expect(runCoreSteps(context)).rejects.toThrow(/linked|regular file/i);
    expect(JSON.parse(readFileSync(outside, "utf-8"))).toEqual({ keep: true });
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("does not publish durable JSON after its parent directory is replaced", () => {
    const root = mkdtempSync(join(tmpdir(), "lax-durable-json-swap-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const parked = join(root, "parked");
    const outside = join(root, "outside");
    mkdirSync(dataDirectory);
    mkdirSync(outside);
    expect(() => writeDurableJson(join(dataDirectory, "state.json"), { safe: true }, {
      fault: () => {
        renameSync(dataDirectory, parked);
        symlinkSync(outside, dataDirectory, process.platform === "win32" ? "junction" : "dir");
      },
    })).toThrow();
    expect(existsSync(join(outside, "state.json"))).toBe(false);
  });

  it("releases the kernel claim when its owner is killed", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lax-mutation-crash-"));
    roots.push(dataDirectory);
    const barrier = join(dataDirectory, "start");
    const child = launch(dataDirectory, barrier);
    const childResult = result(child);
    writeFileSync(barrier, "go");
    expect((await childResult).acquired).toBe(true);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const replacement = await acquireMutationLock(dataDirectory, { task: "replacement" });
    expect(replacement.acquired).toBe(true);
    await releaseMutationLock(replacement);
  });

  it("waits for a killed probe process to exit before cleanup resolves", async () => {
    const probe = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(probe);
    await new Promise<void>((resolve, reject) => {
      probe.once("spawn", resolve);
      probe.once("error", reject);
    });
    await killProbe(probe);
    expect(probe.exitCode !== null || probe.signalCode !== null).toBe(true);
  });

  it("a delayed release cannot disturb a replacement kernel owner", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lax-mutation-observer-"));
    roots.push(dataDirectory);
    const first = await acquireMutationLock(dataDirectory, { task: "first" });
    expect(first.acquired).toBe(true);
    await releaseMutationLock(first);
    const replacement = await acquireMutationLock(dataDirectory, { task: "replacement" });
    expect(replacement.acquired).toBe(true);
    await releaseMutationLock(first);
    expect(await mutationLockHeldByLiveProcess(dataDirectory)).toBe(true);
    expect((await acquireMutationLock(dataDirectory, { task: "third" })).acquired).toBe(false);
    await releaseMutationLock(replacement);
  });

  it("cooperatively stops a revocable owner before a forced rescue acquires", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lax-mutation-revoke-"));
    roots.push(dataDirectory);
    const cancelled = new AbortController();
    let owner;
    owner = await acquireMutationLock(dataDirectory, {
      task: "owner",
      onRevoke: () => { cancelled.abort(); },
    });
    expect(owner.acquired).toBe(true);
    const ownerTask = new Promise<void>((resolve) => cancelled.signal.addEventListener("abort", () => {
      void releaseMutationLock(owner).then(resolve);
    }, { once: true }));
    const rescue = await acquireMutationLock(dataDirectory, { task: "rescue", force: true, revokeTimeoutMs: 2_000 });
    expect(rescue.acquired).toBe(true);
    await ownerTask;
    await releaseMutationLock(rescue);
  });

  it("does not overlap an unresponsive owner during a forced rescue", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lax-mutation-unresponsive-"));
    roots.push(dataDirectory);
    const owner = await acquireMutationLock(dataDirectory, { task: "owner" });
    expect(owner.acquired).toBe(true);
    const rescue = await acquireMutationLock(dataDirectory, { task: "rescue", force: true, revokeTimeoutMs: 100 });
    expect(rescue.acquired).toBe(false);
    expect(await mutationLockHeldByLiveProcess(dataDirectory)).toBe(true);
    await releaseMutationLock(owner);
  });
});
