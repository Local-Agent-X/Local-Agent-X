#!/usr/bin/env node
// Shared install logic invoked by install.bat, install.ps1, install.sh.
// Single source of truth for cross-OS install steps. OS-specific bootstrap
// (Node/Ollama installation) lives in the wrappers; this script runs the
// cross-cutting work that doesn't change between platforms.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NODE_MRileyOR_MIN = 22;
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

// 3. Ollama embedding model pull (idempotent — Ollama skips if already present).
// Daemon-readiness check first: `brew install ollama` puts the binary on
// PATH but doesn't launch the service, so `ollama pull` invoked seconds
// later races the daemon and exits non-zero. Probe the API, start serve in
// the background if needed, then pull. Silent pull-failure was the visible
// failure on 2026-05-17 fresh install — empty `ollama list` post-install
// because pull ran before any daemon existed to receive it.
const OLLAMA_URL = process.env.LAX_OLLAMA_URL || process.env.SAX_OLLAMA_URL || "http://127.0.0.1:11434";
async function ollamaReady() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
async function ensureOllamaUp() {
  if (await ollamaReady()) return true;
  log("Starting Ollama daemon…");
  const { spawn } = await import("node:child_process");
  const daemon = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
  daemon.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    if (await ollamaReady()) return true;
  }
  return false;
}
if (has("ollama")) {
  const ready = await ensureOllamaUp();
  if (!ready) {
    warn(`Ollama daemon didn't come up at ${OLLAMA_URL} — skipping model pull. Re-run later: ollama pull ${EMBED_MODEL}`);
  } else {
    log(`Pulling ${EMBED_MODEL} (~670MB, one-time)…`);
    const pull = run("ollama", ["pull", EMBED_MODEL]);
    if (pull.status === 0) ok("Memory engine ready");
    else warn(`Pull failed — re-run later: ollama pull ${EMBED_MODEL}`);
  }
} else {
  warn(`Ollama not on PATH — semantic memory will be unavailable until you install Ollama and run: ollama pull ${EMBED_MODEL}`);
}

// 4. Default settings scaffold (~/.lax/settings.json).
const laxDir = join(homedir(), ".lax");
const settingsFile = join(laxDir, "settings.json");
if (!existsSync(settingsFile)) {
  mkdirSync(laxDir, { recursive: true });
  // Do NOT seed provider/model — historically we hardcoded anthropic +
  // claude-sonnet-4-6, which created a hidden bug: any user without
  // working Anthropic auth still had settings.provider === "anthropic"
  // on disk, so downstream tools (build_app especially) would resolve
  // "auto" to anthropic and try to spawn Claude CLI even when the user
  // had picked OpenAI/Codex/Grok in the chat dropdown. The onboarding
  // flow ("Connect an AI provider" in the Getting Started panel) forces
  // the first chat into the provider-switcher, which writes settings
  // via /api/providers/switch — so by the time anything actually needs
  // provider+model, they reflect a real working choice the user made.
  const defaults = {
    temperature: 0.7,
    maxIterations: 25,
    embeddingProvider: "ollama",
    // Derive from EMBED_MODEL so the seeded value always matches what the
    // install actually pulled. Previously hardcoded to "nomic-embed-text",
    // which silently mismatched after the move to mxbai-embed-large (1024d,
    // benchmark winner for our memory system) — fresh users had the right
    // model on disk but settings.json pointing at a different one.
    embeddingModel: EMBED_MODEL,
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

// 6. ~/.lax/config.json — packaged Electron reads projectRoot from here so
//    it always runs the live repo's dist/index.js, not a copy baked into
//    the .asar bundle. Merge so we don't clobber port/authToken if set.
const cfgPath = join(laxDir, "config.json");
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
