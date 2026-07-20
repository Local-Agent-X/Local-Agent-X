import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installCheckpointPath } from "../scripts/installer/checkpoint.mjs";
import { runInstaller } from "../scripts/installer/orchestrator.mjs";
import { createReporter } from "../scripts/installer/reporter.mjs";

const directories: string[] = [];
const resumeChild = fileURLToPath(new URL("./fixtures/installer-resume-child.mjs", import.meta.url));
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Harness = {
  directory: string;
  effects: Record<string, number>;
  present: Record<string, "present" | "absent" | "ambiguous">;
  events: Array<Record<string, unknown>>;
  persistedDegraded: Array<Array<{ step: string; message: string }>>;
  run: (options?: { killAt?: string; degradeAt?: string; persistSucceeds?: boolean; selections?: { ollamaRuntime: boolean; ollamaMemoryModel: boolean }; ipc?: boolean }) => Promise<void>;
};

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "lax-install-resume-"));
  directories.push(directory);
  const effects: Record<string, number> = {};
  const present: Record<string, "present" | "absent" | "ambiguous"> = {};
  const events: Array<Record<string, unknown>> = [];
  const persistedDegraded: Array<Array<{ step: string; message: string }>> = [];
  const execute = (reporter: ReturnType<typeof createReporter>, id: string, killAt?: string, degradeAt?: string) => {
    if (!reporter.step(id)) return;
    effects[id] = (effects[id] || 0) + 1;
    if (degradeAt === id) {
      reporter.fail("offline");
      present[id] = "present";
      return;
    }
    if (killAt === `during:${id}`) throw new Error(`killed:${id}`);
    present[id] = "present";
    reporter.stepDone(id, id === "desktop" ? { appInstalled: true, appBuildPath: null } : undefined);
    if (killAt === `after:${id}`) throw new Error(`killed-after:${id}`);
  };
  const run = async ({
    killAt,
    degradeAt,
    persistSucceeds = true,
    selections = { ollamaRuntime: false, ollamaMemoryModel: false },
    ipc = true,
  }: { killAt?: string; degradeAt?: string; persistSucceeds?: boolean; selections?: { ollamaRuntime: boolean; ollamaMemoryModel: boolean }; ipc?: boolean } = {}) => {
    const reporter = createReporter({
      ipcMode: ipc,
      stdout: { write: (line: string) => { events.push(JSON.parse(line)); return true; } } as NodeJS.WriteStream,
      consoleImpl: { log() {}, warn() {}, error() {} } as Console,
      exit: (code: number) => { throw new Error(`exit:${code}`); },
    });
    const stage = (...ids: string[]) => async () => { for (const id of ids) execute(reporter, id, killAt, degradeAt); };
    await runInstaller({
      reporter, platform: "linux", dataDirectory: directory, selections,
      wantOllama: selections.ollamaRuntime,
      wantOllamaMemoryModel: selections.ollamaMemoryModel,
      verifyInstallStep: (id: string) => present[id] || "absent",
    }, {
      prerequisites: stage("node", "ollama"),
      core: stage("npm"),
      posixShell: stage(),
      desktop: async () => {
        execute(reporter, "desktop", killAt, degradeAt);
        return reporter.resumedStepResult("desktop") || { appInstalled: true, appBuildPath: null };
      },
      persist: () => {
        persistedDegraded.push(reporter.degraded.map((item) => ({ ...item })));
        reporter.ipc({ type: "complete" });
        return persistSucceeds;
      },
    });
  };
  return { directory, effects, present, events, persistedDegraded, run };
}

describe("resumable installer checkpoints", () => {
  it("keeps restored degradation in canonical report order", () => {
    const reporter = createReporter({ ipcMode: true, stdout: { write: () => true } as NodeJS.WriteStream });
    reporter.restoreDegraded([
      { step: "embedmodel", message: "model unavailable" },
      { step: "python", message: "python unavailable" },
      { step: "ollama", message: "runtime unavailable" },
    ]);
    expect(reporter.degraded.map((item) => item.step)).toEqual(["python", "ollama", "embedmodel"]);
  });

  it("resumes after a hard interruption without repeating a verified completed effect", async () => {
    const h = harness();
    await expect(h.run({ killAt: "during:ollama" })).rejects.toThrow("killed:ollama");
    expect(h.effects).toEqual({ node: 1, ollama: 1 });
    h.present.ollama = "absent";
    await h.run();
    expect(h.effects).toEqual({ node: 1, ollama: 2, npm: 1, desktop: 1 });
    expect(existsSync(installCheckpointPath(h.directory))).toBe(false);
  });

  it("survives an actual process kill after an external effect", () => {
    const directory = mkdtempSync(join(tmpdir(), "lax-install-kill-"));
    directories.push(directory);
    const killed = spawnSync(process.execPath, [resumeChild, directory, "kill:ollama"], { encoding: "utf-8" });
    expect(killed.status).not.toBe(0);
    expect(existsSync(installCheckpointPath(directory))).toBe(true);

    const resumed = spawnSync(process.execPath, [resumeChild, directory, "complete"], { encoding: "utf-8" });
    expect(resumed.status).toBe(0);
    expect(readFileSync(join(directory, "node.effects"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(directory, "ollama.effects"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(installCheckpointPath(directory))).toBe(false);
  });

  it("recognizes an interrupted effect that completed before the process died", async () => {
    const h = harness();
    await expect(h.run({ killAt: "after:ollama" })).rejects.toThrow("killed-after:ollama");
    await h.run();
    expect(h.effects.ollama).toBe(1);
    expect(h.effects.node).toBe(1);
  });

  it("recognizes a side effect completed before an in-flight checkpoint was cleared", async () => {
    const h = harness();
    await expect(h.run({ killAt: "during:ollama" })).rejects.toThrow("killed:ollama");
    h.present.ollama = "present";
    await h.run();
    expect(h.effects.ollama).toBe(1);
  });

  it("fails closed and remains retryable when an in-flight effect is ambiguous", async () => {
    const h = harness();
    await expect(h.run({ killAt: "during:ollama" })).rejects.toThrow("killed:ollama");
    h.present.ollama = "ambiguous";
    await expect(h.run()).rejects.toThrow("exit:1");
    expect(h.effects.ollama).toBe(1);
    expect(existsSync(installCheckpointPath(h.directory))).toBe(true);
    expect(h.events).toContainEqual(expect.objectContaining({ type: "fatal", retryable: true }));
  });

  it("does not discard or execute through corrupt and truncated state", async () => {
    const h = harness();
    writeFileSync(installCheckpointPath(h.directory), '{"version":1,"completed":[');
    await expect(h.run()).rejects.toThrow("exit:1");
    expect(h.effects).toEqual({});
    expect(readFileSync(installCheckpointPath(h.directory), "utf-8")).toContain('"completed":[');
  });

  it("fails closed on an unsupported checkpoint schema version", async () => {
    const h = harness();
    writeFileSync(installCheckpointPath(h.directory), JSON.stringify({ version: 2, contract: {}, completed: [], inFlight: null, degraded: [] }));
    await expect(h.run()).rejects.toThrow("exit:1");
    expect(h.effects).toEqual({});
  });

  it("revalidates selection drift instead of trusting stale Ollama completion", async () => {
    const h = harness();
    await expect(h.run({ killAt: "during:npm" })).rejects.toThrow("killed:npm");
    h.present.npm = "absent";
    h.present.ollama = "absent";
    await h.run({ selections: { ollamaRuntime: true, ollamaMemoryModel: false } });
    expect(h.effects.node).toBe(1);
    expect(h.effects.ollama).toBe(2);
  });

  it("revalidates a completed step after contract drift", async () => {
    const h = harness();
    await expect(h.run({ killAt: "during:npm" })).rejects.toThrow("killed:npm");
    const path = installCheckpointPath(h.directory);
    const checkpoint = JSON.parse(readFileSync(path, "utf-8"));
    checkpoint.completed.find((item: { id: string }) => item.id === "node").intent = "old-contract";
    writeFileSync(path, JSON.stringify(checkpoint));
    h.present.node = "absent";
    h.present.npm = "absent";
    await h.run();
    expect(h.effects.node).toBe(2);
  });

  it("is idempotent across repeated interruptions", async () => {
    const h = harness();
    await expect(h.run({ killAt: "during:ollama" })).rejects.toThrow();
    h.present.ollama = "absent";
    await expect(h.run({ killAt: "during:npm" })).rejects.toThrow();
    h.present.npm = "absent";
    await h.run();
    expect(h.effects).toEqual({ node: 1, ollama: 2, npm: 2, desktop: 1 });
  });

  it("preserves optional degradation truth across a crash and resume", async () => {
    const h = harness();
    await expect(h.run({ degradeAt: "ollama", killAt: "during:npm" })).rejects.toThrow("killed:npm");
    h.present.npm = "absent";
    await h.run();
    expect(h.persistedDegraded.at(-1)).toEqual([{ step: "ollama", message: "offline" }]);
  });

  it("retains the checkpoint when final outcome persistence fails", async () => {
    const h = harness();
    await h.run({ persistSucceeds: false });
    expect(existsSync(installCheckpointPath(h.directory))).toBe(true);
    await h.run();
    expect(h.effects).toEqual({ node: 1, ollama: 1, npm: 1, desktop: 1 });
    expect(existsSync(installCheckpointPath(h.directory))).toBe(false);
  });

  it.each([true, false])("uses identical resume decisions in IPC mode=%s", async (ipc) => {
    const h = harness();
    await expect(h.run({ killAt: "during:npm", ipc })).rejects.toThrow();
    h.present.npm = "absent";
    await h.run({ ipc });
    expect(h.effects.node).toBe(1);
    expect(h.effects.ollama).toBe(1);
    expect(h.effects.npm).toBe(2);
  });
});
