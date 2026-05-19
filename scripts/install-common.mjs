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

// 2. npm install — retry with legacy peer deps on first failure.
// --loglevel=error hides the transitive-dep deprecation warnings (inflight,
// lodash.isequal, rimraf@2, glob@7, etc.) that come from sub-deps we don't
// directly control. Real errors still surface (npm prints those at error
// level regardless of --loglevel). If a user needs the full output for
// debugging, they can rerun with LAX_NPM_LOGLEVEL=warn.
const npmLogLevel = process.env.LAX_NPM_LOGLEVEL || "error";
log("Installing npm dependencies…");
let res = run("npm", ["install", "--no-audit", "--no-fund", `--loglevel=${npmLogLevel}`]);
if (res.status !== 0) {
  warn("First attempt failed. Retrying with --legacy-peer-deps…");
  res = run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    `--loglevel=${npmLogLevel}`,
    "--legacy-peer-deps",
  ]);
  if (res.status !== 0) fail("npm install failed. See errors above.");
}
ok("npm dependencies installed");

// 3. Ollama embedding model pull (idempotent — Ollama skips if already present).
// Two-stage readiness check before pulling. `brew install ollama` puts the
// binary on PATH but doesn't launch the service, AND when something does
// start the daemon it can serve /api/tags BEFORE its client keypair
// (~/.ollama/id_ed25519) is written. Pulling in that gap returns
// `pull model manifest: open id_ed25519: no such file or directory` —
// the visible failure on 2026-05-17 fresh install. Probe both signals:
// 1. /api/tags responds (daemon listening)
// 2. id_ed25519 keypair exists (registry auth ready)
// Only then call `ollama pull`. On pull failure, retry once after
// restarting the daemon — covers the rare case where a stale daemon
// process started before ~/.ollama was created.
const OLLAMA_URL = process.env.LAX_OLLAMA_URL || process.env.SAX_OLLAMA_URL || "http://127.0.0.1:11434";
const KEYPAIR_PATH = join(homedir(), ".ollama", "id_ed25519");
async function tagsResponding() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
async function ollamaReady() {
  if (!(await tagsResponding())) return false;
  return existsSync(KEYPAIR_PATH);
}
async function ensureOllamaUp() {
  if (await ollamaReady()) return true;
  // If /api/tags responds but keypair is missing, the daemon is in a stuck
  // half-init state (seen when daemon started before ~/.ollama existed).
  // Restart by killing any current ollama serve so the next one inits clean.
  if (await tagsResponding()) {
    log("Ollama daemon up but keypair missing — restarting to reinitialize…");
    spawnSync("pkill", ["-f", "ollama serve"]);
    await new Promise(r => setTimeout(r, 1500));
  } else {
    log("Starting Ollama daemon…");
  }
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
    let pull = run("ollama", ["pull", EMBED_MODEL]);
    // One retry on transient registry/keypair errors. spawn returns the
    // child's exit code; ollama exits non-zero on any pull failure, so
    // restart-then-retry is safe even when the first try succeeded
    // partially (pulls are resumable + content-addressed).
    if (pull.status !== 0) {
      warn("Pull failed on first attempt — restarting daemon and retrying once…");
      spawnSync("pkill", ["-f", "ollama serve"]);
      await new Promise(r => setTimeout(r, 2000));
      const { spawn } = await import("node:child_process");
      spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        if (await ollamaReady()) break;
      }
      pull = run("ollama", ["pull", EMBED_MODEL]);
    }
    if (pull.status === 0) ok("Memory engine ready");
    else warn(`Pull failed twice — semantic memory unavailable. Re-run later: ollama pull ${EMBED_MODEL}`);
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
// Generate authToken upfront if missing. Without this, the first launch
// of the .app hit a race: Electron read config.json with no authToken,
// loaded the renderer with `?token=` (empty), then the server boot
// generated and wrote the authToken — but the frontend already had
// AUTH_TOKEN="" baked into shared.js. Every API call 401'd, WS
// handshake failed, chat didn't work until the user pressed Cmd-R
// (which reloaded with the now-present token in URL). Generating here
// closes the race: when Electron reads the config the authToken is
// already there and the URL is correct on first load.
if (!cfg.authToken) {
  const { randomBytes } = await import("node:crypto");
  cfg.authToken = randomBytes(32).toString("hex");
}
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
ok(`Wired ${cfgPath} → projectRoot=${cfg.projectRoot}, authToken=${cfg.authToken.slice(0,4)}...${cfg.authToken.slice(-4)}`);

// 7. macOS: build the Mac .app and install it to /Applications.
//    Set SAX_SKIP_APP=1 to skip (useful for headless dev iteration).
let appInstalled = false;
let appBuildPath = null;
if (process.platform === "darwin" && !process.env.SAX_SKIP_APP) {
  log("Building Local Agent X.app — this is the slow step the first time (~3–5 min, ~500MB).");

  let r = run(
    "npm",
    ["install", "--no-audit", "--no-fund", `--loglevel=${npmLogLevel}`],
    { cwd: "desktop" },
  );
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
} else if (process.platform === "win32" && !process.env.SAX_SKIP_APP) {
  // Build the Electron desktop subproject so desktop-launch.bat actually
  // launches something. The .bat invokes desktop/node_modules/.bin/electron.cmd
  // with desktop/dist/main.js — both produced here. We skip electron-builder
  // (npm run dist) since the .bat invokes electron directly from the repo
  // checkout, no packaged .exe needed. Live failure 2026-05-18: install
  // completed and created shortcuts, but double-clicking either shortcut
  // exited in milliseconds because dist/main.js + electron.cmd didn't exist.
  log("Building Electron desktop bundle…");
  let dr = run(
    "npm",
    ["install", "--no-audit", "--no-fund", `--loglevel=${npmLogLevel}`],
    { cwd: "desktop" },
  );
  if (dr.status !== 0) fail("desktop npm install failed.");
  dr = run("npm", ["run", "build"], { cwd: "desktop" });
  if (dr.status !== 0) fail("desktop tsc build failed.");
  ok("Desktop bundle built");

  // Create Desktop + Start Menu shortcuts that launch electron.exe DIRECTLY,
  // not via desktop-launch.bat. The .bat works but Windows always spawns a
  // cmd console window for it that lives as long as the Electron process —
  // closing the cmd window kills the server (and the app). Pointing the
  // shortcut at electron.exe makes Windows treat the launch as a pure GUI
  // process: no terminal, matches macOS where the .app launches headless.
  // desktop-launch.bat is kept around for users who want to debug with logs
  // visible (just run it from a terminal); the GUI flow goes through the
  // shortcut.
  //
  // IMPORTANT: resolve Desktop + StartMenu via [Environment]::GetFolderPath
  // inside PowerShell, not via Node's homedir()+"Desktop". When OneDrive
  // backs up the Desktop folder (default for many modern Windows installs),
  // the user's real Desktop is C:\Users\<user>\OneDrive\Desktop — the
  // literal C:\Users\<user>\Desktop either doesn't exist or no longer shows
  // up in Explorer. GetFolderPath uses the Known Folders API and returns
  // the redirected location. Same logic applies to Start Menu under
  // domain-policy folder redirection.
  const repoRoot = process.cwd();
  const electronExe = join(repoRoot, "desktop", "node_modules", "electron", "dist", "electron.exe");
  const mainJs = join(repoRoot, "desktop", "dist", "main.js");
  const workDir = join(repoRoot, "desktop");
  const iconPath = join(repoRoot, "public", "icon.ico");
  if (!existsSync(electronExe) || !existsSync(mainJs)) {
    warn(`Desktop build artifacts missing (${electronExe} or ${mainJs}) — skipping shortcut creation`);
  } else {
    // Single-quoted PowerShell strings: backslashes literal, no var
    // interpolation. Apostrophes in usernames would break this; PS doesn't
    // support a clean escape inside single-quoted literals other than ''
    // doubling — accept that as an unlikely edge case rather than complicate.
    const psElectron = electronExe.replace(/'/g, "''");
    const psMain = mainJs.replace(/'/g, "''");
    const psWork = workDir.replace(/'/g, "''");
    const psIcon = existsSync(iconPath) ? iconPath.replace(/'/g, "''") : "";
    const ps = [
      `$electron = '${psElectron}'`,
      `$mainJs   = '${psMain}'`,
      `$workDir  = '${psWork}'`,
      `$iconPath = '${psIcon}'`,
      `$desktop  = [Environment]::GetFolderPath('Desktop')`,
      `$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'`,
      `if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Force -Path $startMenu | Out-Null }`,
      `foreach ($dir in @($desktop, $startMenu)) {`,
      `  if (-not (Test-Path $dir)) { Write-Output "[skip] $dir (not present)"; continue }`,
      `  $lnk = Join-Path $dir 'Local Agent X.lnk'`,
      `  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)`,
      `  $s.TargetPath = $electron`,
      `  $s.Arguments = '"' + $mainJs + '"'`,
      `  $s.WorkingDirectory = $workDir`,
      `  if ($iconPath) { $s.IconLocation = $iconPath }`,
      `  $s.Description = 'Local Agent X'`,
      `  $s.Save()`,
      `  Write-Output "[ok]   $lnk"`,
      `}`,
    ].join("; ");

    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { stdio: "inherit" },
    );
    if (r.status === 0) {
      ok("Shortcuts created (Desktop + Start Menu, resolved via Known Folders API)");
      appInstalled = true;
    } else {
      warn(`Shortcut creation failed (exit ${r.status}) — launch manually: ${batPath}`);
    }
  }
} else if (process.platform === "linux") {
  log("(Linux: no native app target yet — use `npm run dev` to launch the server.)");
}

console.log("");
log("Install complete.");
if (appInstalled && process.platform === "darwin") {
  log("  Launch:      open Launchpad, click \"Local Agent X\"");
  log("  First time:  right-click the icon → Open → Open (one-time Gatekeeper prompt)");
  log("  Close-X:     keeps server running in the menu bar; use the tray menu to Quit");
} else if (appInstalled && process.platform === "win32") {
  log("  Launch:      double-click \"Local Agent X\" on your Desktop or Start Menu");
  log("  First time:  Windows may show SmartScreen — click \"More info\" → \"Run anyway\"");
} else if (process.platform === "darwin" && appBuildPath) {
  log(`  App built at: ${appBuildPath} (drag to /Applications manually)`);
}
log("  CLI (headless): npm run dev   →   http://127.0.0.1:7007");
