#!/usr/bin/env node
// Shared install logic invoked by install.bat, install.ps1, install.sh.
// Single source of truth for cross-OS install steps. OS-specific bootstrap
// (Node/Ollama installation) lives in the wrappers; this script runs the
// cross-cutting work that doesn't change between platforms.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NODE_MAJOR_MIN = 22;
const EMBED_MODEL = "mxbai-embed-large";

const log  = (m) => console.log(`[install] ${m}`);
const ok   = (m) => console.log(`[ok] ${m}`);
const warn = (m) => console.warn(`[warn] ${m}`);
const fail = (m) => { console.error(`[error] ${m}`); process.exit(1); };

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
}
function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore", shell: true }).status === 0;
}

// 1. Node version assertion
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < NODE_MAJOR_MIN) {
  fail(`Node ${NODE_MAJOR_MIN}+ required (found v${process.versions.node})`);
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

// 5. Production build of the server — FAIL-CLOSED. tsc failures most
//    often signal a broken AriKernel contract (the security/policy gate
//    the runtime hard-requires). We refuse to ship an install that papers
//    over those errors, even though the .app technically has a tsx
//    fallback for dist/-missing cases — a broken build is a signal worth
//    stopping for, not silencing.
log("Building server (npm run build)…");
res = run("npm", ["run", "build"]);
if (res.status !== 0) fail("npm run build failed. Fix the build errors above before re-running install — the runtime refuses to boot when its security layer (AriKernel pre-dispatch gate) can't wire.");
ok("Server build complete");

// 6. ~/.sax/config.json — packaged Electron reads projectRoot from here so
//    it always runs the live repo's dist/index.js, not a copy baked into
//    the .asar bundle. Merge so we don't clobber port/authToken if set.
const cfgPath = join(saxDir, "config.json");
let cfg = {};
if (existsSync(cfgPath)) {
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf-8")); } catch {}
}
cfg.projectRoot = process.cwd();
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
ok(`Wired ${cfgPath} → projectRoot=${cfg.projectRoot}`);

// 7. macOS: build the Mac .app and install it to /Applications.
//    Set SAX_SKIP_APP=1 to skip (useful for headless dev iteration).
let appInstalled = false;
let appBuildPath = null;
if (process.platform === "darwin" && !process.env.SAX_SKIP_APP) {
  log("Building Local Agent X.app — this is the slow step the first time (~3–5 min, ~500MB).");

  let r = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: "desktop" });
  if (r.status !== 0) fail("desktop npm install failed.");

  r = run("npm", ["run", "build"], { cwd: "desktop" });
  if (r.status !== 0) fail("desktop tsc build failed.");

  r = run("npm", ["run", "dist"], { cwd: "desktop" });
  if (r.status !== 0) fail("electron-builder failed.");

  // electron-builder writes to mac-arm64/ on Apple Silicon, mac/ on Intel.
  const releaseDir = join(process.cwd(), "desktop", "release");
  for (const sub of ["mac-arm64", "mac"]) {
    const candidate = join(releaseDir, sub, "Local Agent X.app");
    if (existsSync(candidate)) { appBuildPath = candidate; break; }
  }
  if (!appBuildPath) fail(`Could not locate built .app under ${releaseDir}`);

  const dest = "/Applications/Local Agent X.app";
  if (existsSync(dest)) {
    log(`Removing previous ${dest}`);
    run("rm", ["-rf", dest]);
  }
  log(`Installing → ${dest}`);
  r = run("cp", ["-R", appBuildPath, dest]);
  if (r.status === 0) {
    ok("Local Agent X.app installed to /Applications");
    appInstalled = true;
  } else {
    warn(`Could not copy to /Applications (permission denied?). Built app is at:\n  ${appBuildPath}`);
  }
} else if (process.platform === "linux") {
  log("(Linux: no native app target yet — use `npm run dev` to launch the server.)");
}

console.log("");
log("Install complete.");
if (appInstalled) {
  log("  Launch:      open Launchpad, click \"Local Agent X\"");
  log("  First time:  right-click the icon → Open → Open (one-time Gatekeeper prompt)");
  log("  Close-X:     keeps server running in the menu bar; use the tray menu to Quit");
} else if (process.platform === "darwin" && appBuildPath) {
  log(`  App built at: ${appBuildPath} (drag to /Applications manually)`);
}
log("  CLI (headless): npm run dev   →   http://127.0.0.1:7007");
