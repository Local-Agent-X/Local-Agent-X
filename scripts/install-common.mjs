#!/usr/bin/env node
// Shared install logic invoked by install.bat, install.ps1, install.sh.
// Single source of truth for cross-OS install steps. OS-specific bootstrap
// (Node/Ollama installation) lives in the wrappers; this script runs the
// cross-cutting work that doesn't change between platforms.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NODE_MRileyOR_MIN = 22;
const EMBED_MODEL = "mxbai-embed-large";

const log  = (m) => console.log(`[install] ${m}`);
const ok   = (m) => console.log(`[ok] ${m}`);
const warn = (m) => console.warn(`[warn] ${m}`);
const fail = (m) => { console.error(`[error] ${m}`); process.exit(1); };

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
}
function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore", shell: true }).status === 0;
}

// 1. Node version assertion
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < NODE_MRileyOR_MIN) {
  fail(`Node ${NODE_MRileyOR_MIN}+ required (found v${process.versions.node})`);
}
ok(`Node v${process.versions.node}`);

// 2. npm install — retry with legacy peer deps on first failure
log("Installing npm dependencies…");
let res = run("npm", ["install", "--no-audit", "--no-fund"]);
if (res.status !== 0) {
  warn("First attempt failed. Retrying with --legacy-peer-deps…");
  res = run("npm", ["install", "--no-audit", "--no-fund", "--legacy-peer-deps"]);
  if (res.status !== 0) fail("npm install failed. See errors above.");
}
ok("npm dependencies installed");

// 3. Ollama embedding model pull (idempotent — Ollama skips if already present)
if (has("ollama")) {
  log(`Pulling ${EMBED_MODEL} (~670MB, one-time)…`);
  const pull = run("ollama", ["pull", EMBED_MODEL]);
  if (pull.status === 0) ok("Memory engine ready");
  else warn(`Pull failed — re-run later: ollama pull ${EMBED_MODEL}`);
} else {
  warn(`Ollama not on PATH — semantic memory will be unavailable until you install Ollama and run: ollama pull ${EMBED_MODEL}`);
}

// 4. Default settings scaffold (~/.sax/settings.json)
const saxDir = join(homedir(), ".sax");
const settingsFile = join(saxDir, "settings.json");
if (!existsSync(settingsFile)) {
  mkdirSync(saxDir, { recursive: true });
  const defaults = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    temperature: 0.7,
    maxIterations: 25,
    embeddingProvider: "ollama",
    embeddingModel: "nomic-embed-text:latest",
  };
  writeFileSync(settingsFile, JSON.stringify(defaults, null, 2));
  ok(`Seeded ${settingsFile}`);
} else {
  ok("Settings already present");
}

console.log("");
log("Install complete.");
log("  Dev mode:    npm run dev");
log("  Prod build:  npm run build && npm start");
log("  UI:          http://127.0.0.1:7007");
