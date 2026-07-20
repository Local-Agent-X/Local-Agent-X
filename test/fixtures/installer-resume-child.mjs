import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInstaller } from "../../scripts/installer/orchestrator.mjs";
import { createReporter } from "../../scripts/installer/reporter.mjs";

const [directory, mode] = process.argv.slice(2);
const reporter = createReporter({ ipcMode: true });
const marker = (id) => join(directory, `${id}.present`);
const effect = (id) => {
  appendFileSync(join(directory, `${id}.effects`), "effect\n");
  writeFileSync(marker(id), "present");
};
const execute = (id) => {
  if (!reporter.step(id)) return;
  effect(id);
  if (mode === `kill:${id}`) process.kill(process.pid, "SIGKILL");
  reporter.stepDone(id);
};

await runInstaller({
  reporter,
  platform: "linux",
  dataDirectory: directory,
  selections: { ollamaRuntime: false, ollamaMemoryModel: false },
  verifyInstallStep: (id) => existsSync(marker(id)) ? "present" : "absent",
}, {
  prerequisites: async () => { execute("node"); execute("ollama"); },
  core: async () => { execute("npm"); },
  posixShell: async () => {},
  desktop: async () => ({ appInstalled: false, appBuildPath: null }),
  persist: () => true,
});
