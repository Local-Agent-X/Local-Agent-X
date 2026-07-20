import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stepsPlan, wantsOllama } from "../scripts/installer/contract.mjs";

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
