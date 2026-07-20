import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanLines, parsePercent } from "./reporter.mjs";

export const RUNTIME_NODE_PATH_AUGMENTS = [
  join(homedir(), ".lax/runtime/bin"),
  "/opt/homebrew/bin", "/opt/homebrew/sbin",
  "/usr/local/bin", "/usr/local/sbin",
  join(homedir(), ".nvm/versions/node/current/bin"),
];

export function runtimeNodeEnv(platform = process.platform, env = process.env) {
  if (platform === "win32") return undefined;
  const existing = (env.PATH || "").split(":");
  const merged = [...RUNTIME_NODE_PATH_AUGMENTS, ...existing].filter((path, index, all) => path && all.indexOf(path) === index);
  return { ...env, PATH: merged.join(":") };
}

export function createProcessTools(reporter, { platform = process.platform, spawnProcess = spawn, spawnProcessSync = spawnSync } = {}) {
  const run = (cmd, args, opts = {}) => {
    if (!reporter.ipcMode) return spawnProcessSync(cmd, args, { stdio: "inherit", shell: platform === "win32", ...opts });
    const result = spawnProcessSync(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"], shell: platform === "win32", encoding: "utf-8", ...opts,
    });
    for (const line of cleanLines(result.stdout)) reporter.ipc({ type: "log", level: "info", id: reporter.currentStep(), line });
    for (const line of cleanLines(result.stderr)) reporter.ipc({ type: "log", level: "warn", id: reporter.currentStep(), line });
    return result;
  };

  const runStreaming = (cmd, args, opts = {}) => {
    if (!reporter.ipcMode) {
      return Promise.resolve(spawnProcessSync(cmd, args, { stdio: "inherit", shell: platform === "win32", ...opts }));
    }
    return new Promise((resolve) => {
      const stepId = reporter.currentStep();
      const child = spawnProcess(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: platform === "win32", ...opts });
      let lastPercent = -1;
      const buffers = { info: "", warn: "" };
      let settled = false;
      const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
      const pump = (level, text) => {
        const line = text.trim();
        if (!line) return;
        reporter.ipc({ type: "log", level, id: stepId, line });
        const percent = parsePercent(line);
        if (percent !== null && percent !== lastPercent) {
          lastPercent = percent;
          reporter.ipc({ type: "progress", id: stepId, percent });
        }
      };
      const sink = (level) => (chunk) => {
        buffers[level] += chunk.toString("utf-8");
        let index;
        while ((index = buffers[level].search(/[\r\n]/)) !== -1) {
          pump(level, buffers[level].slice(0, index));
          buffers[level] = buffers[level].slice(index + 1);
        }
      };
      child.stdout?.on("data", sink("info"));
      child.stderr?.on("data", sink("warn"));
      child.on("error", (error) => { pump("warn", String(error?.message || error)); finish({ status: -1, error }); });
      child.on("close", (code) => {
        pump("info", buffers.info);
        pump("warn", buffers.warn);
        finish({ status: code ?? -1 });
      });
    });
  };
  const has = (cmd) => spawnProcessSync(cmd, ["--version"], { stdio: "ignore", shell: true }).status === 0;
  return { run, runStreaming, has, spawnSync: spawnProcessSync, spawn: spawnProcess };
}
