import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installerSelections, stepsPlan, wantsOllama, wantsOllamaMemoryModel } from "../scripts/installer/contract.mjs";
import { runOllamaModelStep } from "../scripts/installer/ollama-model-step.mjs";
import { runInstaller } from "../scripts/installer/orchestrator.mjs";
import { persistInstallOutcome } from "../scripts/installer/persistence.mjs";
import { runOllamaPrerequisite } from "../scripts/installer/prerequisite-steps.mjs";
import { createReporter } from "../scripts/installer/reporter.mjs";
import { readInstallReport } from "../src/server/setup-status.js";

const child = fileURLToPath(new URL("./fixtures/installer-contract-child.mjs", import.meta.url));
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [child, ...args], { encoding: "utf8", env });
const events = (stdout: string) => stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

describe("installer plan contract", () => {
  it("keeps platform step order and filtering canonical", () => {
    expect(stepsPlan("win32").map((step) => step.id)).toEqual([
      "node", "vsbuildtools", "python", "ollama", "npm", "embedmodel", "settings", "build", "config", "posixshell", "desktop",
    ]);
    expect(stepsPlan("darwin").map((step) => step.id)).toEqual([
      "node", "xcode-clt", "python", "ollama", "npm", "embedmodel", "settings", "build", "config", "desktop",
    ]);
    expect(stepsPlan("linux").map((step) => step.id)).toEqual([
      "node", "python", "ollama", "npm", "embedmodel", "settings", "build", "config", "desktop",
    ]);
    for (const platform of ["win32", "darwin", "linux"]) {
      const result = run(["complete", "--ipc", `--platform=${platform}`]);
      expect(events(result.stdout)[0]).toEqual({ type: "plan", steps: stepsPlan(platform) });
    }
  });

  it("keeps Ollama opt-in exact and default-off", () => {
    expect(wantsOllama({} as NodeJS.ProcessEnv)).toBe(false);
    expect(wantsOllama({ LAX_INSTALL_OLLAMA: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(wantsOllama({ LAX_INSTALL_OLLAMA: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(wantsOllama({ LAX_INSTALL_OLLAMA: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it.each([
    [undefined, undefined, false, false],
    ["1", undefined, true, false],
    [undefined, "1", false, true],
    ["true", "true", true, true],
  ])("keeps runtime %s and model %s as independent choices", (runtime, model, ollamaRuntime, ollamaModel) => {
    const env = { LAX_INSTALL_OLLAMA: runtime, LAX_INSTALL_OLLAMA_MEMORY_MODEL: model } as NodeJS.ProcessEnv;
    expect(wantsOllamaMemoryModel(env)).toBe(ollamaModel);
    expect(installerSelections(env)).toEqual({ ollamaRuntime, ollamaMemoryModel: ollamaModel });
  });

  it("keeps hardware onboarding advisory and exact-target verification explicit", () => {
    const view = readFileSync(fileURLToPath(new URL("../installer/Views/MainWindow.axaml", import.meta.url)), "utf-8");
    const evidence = readFileSync(fileURLToPath(new URL("../installer/ViewModels/MainWindowViewModel.Hardware.cs", import.meta.url)), "utf-8");
    const runtimeUi = readFileSync(fileURLToPath(new URL("../public/js/settings-local-runtimes.js", import.meta.url)), "utf-8");
    expect(view).toContain("Hardware and local AI evidence");
    expect(view).toContain("Install Ollama local AI runtime");
    expect(evidence).toContain("verify an exact runtime/model after launch");
    expect(evidence).toContain("No chat default changes automatically");
    expect(evidence).toContain('RunLines("ollama", "list")');
    expect(evidence).not.toMatch(/ollama[^\n]{0,30}\bpull\b/i);
    expect(runtimeUi).toContain("INSTALL-TIME HARDWARE EVIDENCE");
    expect(runtimeUi).toContain("Unknown or unsupported hardware does not block");
    expect(runtimeUi).toContain("declared runtime identity + runtime version + model digest recorded");
  });
});

describe("Ollama model acquisition", () => {
  const reporter = () => createReporter({
    ipcMode: true,
    stdout: { write: () => true } as NodeJS.WriteStream,
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, true],
    [true, true, true],
  ])("runtime=%s and memory-model=%s makes model pull=%s", async (wantOllama, wantOllamaMemoryModel, shouldPull) => {
    const calls: string[] = [];
    const processes = {
      has: (name: string) => { calls.push(`has:${name}`); return true; },
      runStreaming: async (name: string, args: string[]) => {
        calls.push(`${name} ${args.join(" ")}`);
        return { status: 0 };
      },
    };
    const ready = { url: "http://127.0.0.1:11434", ready: async () => true, ensureUp: async () => true };
    await runOllamaModelStep(
      { reporter: reporter(), processes, wantOllama, wantOllamaMemoryModel },
      { createReadiness: () => ready },
    );
    expect(calls.includes("ollama pull mxbai-embed-large")).toBe(shouldPull);
  });

  it("never probes, starts, or pulls a model for a runtime-only install", async () => {
    const calls: string[] = [];
    const processes = {
      has: (name: string) => { calls.push(`has:${name}`); return true; },
      runStreaming: async (name: string) => { calls.push(`stream:${name}`); return { status: 0 }; },
      spawn: (name: string) => { calls.push(`spawn:${name}`); throw new Error("unexpected spawn"); },
    };
    expect(await runOllamaModelStep({ reporter: reporter(), processes, wantOllama: true, wantOllamaMemoryModel: false })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("pulls only the fixed memory model after an explicit model opt-in", async () => {
    const calls: Array<{ name: string; args?: string[] }> = [];
    const processes = {
      has: (name: string) => { calls.push({ name: `has:${name}` }); return true; },
      runStreaming: async (name: string, args: string[]) => { calls.push({ name: `stream:${name}`, args }); return { status: 0 }; },
    };
    const ready = { url: "http://127.0.0.1:11434", ready: async () => true, ensureUp: async () => true };
    expect(await runOllamaModelStep(
      { reporter: reporter(), processes, wantOllama: false, wantOllamaMemoryModel: true },
      { createReadiness: () => ready },
    )).toBe(true);
    expect(calls).toEqual([
      { name: "has:ollama" },
      { name: "stream:ollama", args: ["pull", "mxbai-embed-large"] },
    ]);
  });

  it("records an explicit model request as degraded when no runtime exists", async () => {
    const installReporter = reporter();
    const ready = await runOllamaModelStep({
      reporter: installReporter,
      processes: { has: () => false },
      wantOllama: false,
      wantOllamaMemoryModel: true,
    });
    expect(ready).toBe(false);
    expect(installReporter.degraded).toEqual([expect.objectContaining({ step: "embedmodel" })]);
  });
});

describe("installer child-process framing", () => {
  it("emits plan, optional degradation, and completion as JSONL", () => {
    const result = run(["optional", "--ipc", "--platform=win32"], {
      ...process.env,
      LAX_INSTALL_OLLAMA: "1",
      LAX_INSTALL_OLLAMA_MEMORY_MODEL: "0",
    });
    expect(result.status).toBe(0);
    const output = events(result.stdout);
    expect(output[0]).toEqual({ type: "plan", steps: stepsPlan("win32") });
    expect(output).toContainEqual({ type: "log", level: "info", id: null, line: "ollama=true" });
    expect(output).toContainEqual({ type: "log", level: "info", id: null, line: "ollama-memory-model=false" });
    expect(output).toContainEqual({ type: "step", id: "ollama", state: "done" });
    expect(output.at(-1)).toEqual({ type: "complete" });
  });

  it("emits required error and fatal without completion", () => {
    const result = run(["fatal", "--ipc"]);
    expect(result.status).toBe(1);
    const output = events(result.stdout);
    expect(output).toContainEqual({ type: "step", id: "node", state: "error", message: "unsupported" });
    expect(output.at(-1)).toEqual({ type: "fatal", message: "unsupported" });
    expect(output.some((event) => event.type === "complete")).toBe(false);
  });

  it("keeps prose mode free of JSON framing", () => {
    const result = run(["complete"], { ...process.env, LAX_INSTALL_OLLAMA: "0" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      "[install] ollama=false",
      "[install] ollama-memory-model=false",
    ]);
  });

  it("allows the GUI cancellation model to terminate a live child", async () => {
    const processChild = spawn(process.execPath, [child, "wait", "--ipc"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    processChild.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      processChild.stdout.once("data", () => resolve());
      processChild.once("error", reject);
    });
    processChild.kill();
    const exit = await new Promise<number | null>((resolve) => processChild.once("exit", resolve));
    expect(exit).not.toBe(0);
    const output = events(stdout);
    expect(output[0]).toEqual({ type: "plan", steps: stepsPlan("linux") });
    expect(output).toContainEqual({ type: "step", id: "node", state: "running", detail: null });
    expect(output.some((event) => event.type === "complete" || event.type === "fatal")).toBe(false);
  });
});

describe("Windows Ollama delivery fallback", () => {
  const exercise = async (directResult: boolean) => {
    const calls: Array<{ name: string; args?: string[] }> = [];
    const events: unknown[] = [];
    const reporter = createReporter({
      ipcMode: true,
      stdout: { write: (line: string) => { events.push(JSON.parse(line)); return true; } } as NodeJS.WriteStream,
    });
    const processes = {
      has: (command: string) => { calls.push({ name: `has:${command}` }); return command === "winget"; },
      runStreaming: async (command: string, args: string[]) => {
        calls.push({ name: `stream:${command}`, args });
        return { status: 17 };
      },
    };
    await runOllamaPrerequisite(
      { reporter, processes, platform: "win32" },
      true,
      { directWindowsInstaller: async () => { calls.push({ name: "direct" }); return directResult; } },
    );
    return { calls, events, reporter };
  };

  it("tries the official direct installer after a present-but-failing winget", async () => {
    const { calls, reporter } = await exercise(true);
    expect(calls).toEqual([
      { name: "has:ollama" },
      { name: "has:winget" },
      {
        name: "stream:winget",
        args: ["install", "Ollama.Ollama", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent"],
      },
      { name: "direct" },
    ]);
    expect(reporter.degraded).toEqual([]);
  });

  it("degrades only after winget and the direct installer both fail", async () => {
    const { calls, events, reporter } = await exercise(false);
    expect(calls.at(-1)).toEqual({ name: "direct" });
    expect(reporter.degraded).toEqual([{
      step: "ollama",
      message: "Ollama couldn't be installed via winget or its official installer. Install it from https://ollama.com/download and re-run to enable semantic memory",
    }]);
    expect(events).toContainEqual({ type: "step", id: "ollama", state: "done" });
    expect(events.some((event) => (event as { type?: string }).type === "fatal")).toBe(false);
  });
});

describe("canonical orchestration durability and IPC ordering", () => {
  const noOp = async () => {};
  const desktop = async () => ({ appInstalled: false, appBuildPath: null });

  it("persists the exact independent selections and replaces stale report choices on rerun", () => {
    const directory = mkdtempSync(join(tmpdir(), "installer-selections-"));
    const installReporter = createReporter({ ipcMode: true, stdout: { write: () => true } as NodeJS.WriteStream });
    try {
      persistInstallOutcome({
        reporter: installReporter,
        platform: "linux",
        env: {},
        dataDirectory: directory,
        selections: { ollamaRuntime: true, ollamaMemoryModel: false },
      }, desktop());
      let report = readInstallReport(directory);
      expect(report?.selections).toEqual({ ollamaRuntime: true, ollamaMemoryModel: false });

      persistInstallOutcome({
        reporter: installReporter,
        platform: "linux",
        env: {},
        dataDirectory: directory,
        selections: { ollamaRuntime: false, ollamaMemoryModel: true },
      }, desktop());
      report = readInstallReport(directory);
      expect(report?.selections).toEqual({ ollamaRuntime: false, ollamaMemoryModel: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("persists optional degradation before emitting complete and roundtrips through setup status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "installer-outcome-"));
    try {
      const output: string[] = [];
      let reportPresentAtComplete = false;
      const reporter = createReporter({
        ipcMode: true,
        stdout: {
          write: (line: string) => {
            output.push(line);
            if (JSON.parse(line).type === "complete") reportPresentAtComplete = existsSync(join(directory, "install-report.json"));
            return true;
          },
        } as NodeJS.WriteStream,
      });
      const prerequisites = async () => {
        reporter.step("ollama");
        reporter.fail("offline");
        reporter.stepDone("ollama");
      };
      await runInstaller(
        { reporter, platform: "linux", env: {}, dataDirectory: directory },
        { prerequisites, core: noOp, posixShell: noOp, desktop, persist: persistInstallOutcome },
      );
      expect(reportPresentAtComplete).toBe(true);
      expect(readInstallReport(directory)?.degraded).toEqual([{ step: "ollama", message: "offline" }]);
      const emitted = events(output.join(""));
      expect(emitted[0]).toEqual({ type: "plan", steps: stepsPlan("linux") });
      expect(emitted.findIndex((event) => event.type === "complete"))
        .toBeGreaterThan(emitted.findIndex((event) => event.type === "step" && event.id === "ollama" && event.state === "done"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("frames required fatal in GUI order without persistence or false completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "installer-fatal-"));
    try {
      const output: string[] = [];
      const reporter = createReporter({
        ipcMode: true,
        stdout: { write: (line: string) => { output.push(line); return true; } } as NodeJS.WriteStream,
        exit: (code) => { throw new Error(`exit:${code}`); },
      });
      const prerequisites = async () => { reporter.step("node"); reporter.fail("unsupported"); };
      await expect(runInstaller(
        { reporter, platform: "linux", env: {}, dataDirectory: directory },
        { prerequisites, core: noOp, posixShell: noOp, desktop, persist: persistInstallOutcome },
      )).rejects.toThrow("exit:1");
      expect(existsSync(join(directory, "install-report.json"))).toBe(false);
      const emitted = events(output.join(""));
      expect(emitted.map((event) => event.type)).toEqual(["plan", "step", "log", "step", "fatal"]);
      expect(emitted[1]).toEqual({ type: "step", id: "node", state: "running", detail: null });
      expect(emitted.at(-1)).toEqual({ type: "fatal", message: "unsupported" });
      expect(emitted.some((event) => event.type === "complete")).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
