#!/usr/bin/env node
// Shared installer entry invoked by install.bat, install.ps1, and install.sh.
// IPC mode emits the JSONL contract consumed by the Avalonia GUI:
// plan, step, log, progress, complete, and fatal events.

import { wantsOllama } from "./installer/contract.mjs";
import { createReporter } from "./installer/reporter.mjs";
import { createProcessTools } from "./installer/process-tools.mjs";
import { upgradeNode } from "./installer/node-upgrade.mjs";
import { runInstaller } from "./installer/orchestrator.mjs";

const ipcMode = process.argv.includes("--ipc");
const reporter = createReporter({ ipcMode });
const processes = createProcessTools(reporter);
const context = {
  reporter,
  processes,
  platform: process.platform,
  env: process.env,
  wantOllama: wantsOllama(),
};

if (process.argv.includes("--upgrade-node")) {
  process.exit(await upgradeNode(context));
}

await runInstaller(context);
