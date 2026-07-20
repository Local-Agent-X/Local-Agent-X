import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stepsPlan, wantsOllama } from "../scripts/installer/contract.mjs";
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
});

describe("installer child-process framing", () => {
  it("emits plan, optional degradation, and completion as JSONL", () => {
    const result = run(["optional", "--ipc", "--platform=win32"], { ...process.env, LAX_INSTALL_OLLAMA: "1" });
    expect(result.status).toBe(0);
    const output = events(result.stdout);
    expect(output[0]).toEqual({ type: "plan", steps: stepsPlan("win32") });
    expect(output).toContainEqual({ type: "log", level: "info", id: null, line: "ollama=true" });
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
    expect(result.stdout.trim()).toBe("[install] ollama=false");
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
