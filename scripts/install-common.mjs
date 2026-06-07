#!/usr/bin/env node
// Shared install logic invoked by install.bat, install.ps1, install.sh.
// Single source of truth for cross-OS install steps. OS-specific bootstrap
// (Node/Ollama installation) lives in the wrappers; this script runs the
// cross-cutting work that doesn't change between platforms.
//
// IPC mode (`--ipc` flag): in addition to the prose `[install] / [ok] /
// [warn] / [error]` lines, emit one JSON object per line to stdout marking
// step boundaries. Consumed by the Avalonia GUI installer so it can render
// a step list, progress icons, and a friendly status without parsing
// English. Schema:
//   {"type":"plan","steps":[{"id":"npm","label":"App dependencies"}, ...]}
//   {"type":"step","id":"npm","state":"running","detail":"..."}
//   {"type":"step","id":"npm","state":"done"}
//   {"type":"step","id":"npm","state":"error","message":"..."}
//   {"type":"log","level":"info|ok|warn|error","id":"<currentStep|null>","line":"..."}
//   {"type":"progress","id":"<currentStep>","percent":0-100}  ← live % for the bar
//   {"type":"complete"}    ← final success
//   {"type":"fatal","message":"..."}  ← terminal failure
// Prose mode behavior is unchanged when --ipc is absent.

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NODE_MAJOR_MIN = 22;
const EMBED_MODEL = "mxbai-embed-large";
const IPC = process.argv.includes("--ipc");

// Windows uninstaller written into the install dir + registered in Add/Remove
// Programs (see the win32 desktop step). String.raw keeps PowerShell's `\` and
// `$` literal. __INSTALL_DIR__ is substituted at write time. It self-relaunches
// from %TEMP% so it can delete its own directory, and asks (Yes/No/Cancel)
// before removing ~/.lax — that's the user's chats, memory, and saved keys.
const UNINSTALL_PS1 = String.raw`# Local Agent X uninstaller — registered by scripts/install-common.mjs.
param([switch]$FromTemp)
$ErrorActionPreference = 'SilentlyContinue'
$InstallDir = '__INSTALL_DIR__'
$RegKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalAgentX'

# Re-launch from %TEMP% so we can delete our own install dir without a self-lock.
if (-not $FromTemp) {
  $tmp = Join-Path $env:TEMP 'lax-uninstall.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $tmp -Force
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $tmp + '"'),'-FromTemp'
  return
}

Add-Type -AssemblyName System.Windows.Forms
$nl = [Environment]::NewLine
$ans = [System.Windows.Forms.MessageBox]::Show('Remove Local Agent X?' + $nl + $nl + 'Also delete your data (chats, memory, saved API keys)? Choose No to keep it for a future reinstall.', 'Uninstall Local Agent X', [System.Windows.Forms.MessageBoxButtons]::YesNoCancel, [System.Windows.Forms.MessageBoxIcon]::Warning)
if ($ans -eq [System.Windows.Forms.DialogResult]::Cancel) { return }

Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$paths = @($InstallDir, (Join-Path $env:APPDATA 'electron'), (Join-Path $env:APPDATA 'Local Agent X'))
if ($ans -eq [System.Windows.Forms.DialogResult]::Yes) { $paths += (Join-Path $env:USERPROFILE '.lax') }
foreach ($p in $paths) { if ($p -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue } }

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
foreach ($lnk in @((Join-Path $desktop 'Local Agent X.lnk'), (Join-Path $startMenu 'Local Agent X.lnk'))) { if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue } }

Remove-Item -LiteralPath $RegKey -Recurse -Force -ErrorAction SilentlyContinue
[System.Windows.Forms.MessageBox]::Show('Local Agent X has been removed.' + $nl + '(Ollama and the AI model were left installed.)', 'Uninstall complete', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
`;

// The step plan emitted up front so the UI can render the full list before
// any step runs. Step ids must match the ones passed to step()/stepDone()/
// stepError() below — a typo means the UI gets an event for an unknown id.
// `platforms` decides which steps appear on which OS; the filter below
// computes STEPS_PLAN for the current platform so the UI never shows a
// step that won't run (e.g. Mac users don't see "C++ build tools" because
// xcode-clt covers that on macOS).
const ALL_STEPS = [
  { id: "node",         label: "Node.js runtime",          platforms: ["win32", "darwin", "linux"] },
  { id: "vsbuildtools", label: "C++ build tools",          platforms: ["win32"] },
  { id: "xcode-clt",    label: "Xcode Command Line Tools", platforms: ["darwin"] },
  { id: "python",       label: "Python 3.12",              platforms: ["win32", "darwin", "linux"] },
  { id: "ollama",       label: "Ollama AI runtime",        platforms: ["win32", "darwin", "linux"] },
  { id: "npm",          label: "App dependencies",         platforms: ["win32", "darwin", "linux"] },
  { id: "embedmodel",   label: "AI memory engine",         platforms: ["win32", "darwin", "linux"] },
  { id: "settings",     label: "User settings",            platforms: ["win32", "darwin", "linux"] },
  { id: "build",        label: "App build",                platforms: ["win32", "darwin", "linux"] },
  { id: "config",       label: "Configuration",            platforms: ["win32", "darwin", "linux"] },
  { id: "desktop",      label: "Desktop app",              platforms: ["win32", "darwin", "linux"] },
];

const STEPS_PLAN = ALL_STEPS
  .filter(s => s.platforms.includes(process.platform))
  .map(({ id, label }) => ({ id, label }));

let currentStepId = null;

function ipc(event) {
  if (!IPC) return;
  try { process.stdout.write(JSON.stringify(event) + "\n"); } catch { /* swallow */ }
}
function step(id, detail) {
  // Auto-finalize previous step if step() called without explicit stepDone()
  // (defensive — keeps the event stream clean even if a step block forgets to
  // mark itself done, which is easy to do mid-refactor).
  if (currentStepId && currentStepId !== id) {
    ipc({ type: "step", id: currentStepId, state: "done" });
  }
  currentStepId = id;
  ipc({ type: "step", id, state: "running", detail: detail || null });
}
function stepDone(id) {
  ipc({ type: "step", id, state: "done" });
  if (currentStepId === id) currentStepId = null;
}
function stepError(id, message) {
  ipc({ type: "step", id, state: "error", message });
  if (currentStepId === id) currentStepId = null;
}

const log  = (m) => { if (!IPC) console.log(`[install] ${m}`); ipc({ type: "log", level: "info",  id: currentStepId, line: m }); };
const ok   = (m) => { if (!IPC) console.log(`[ok] ${m}`);      ipc({ type: "log", level: "ok",    id: currentStepId, line: m }); };
const warn = (m) => { if (!IPC) console.warn(`[warn] ${m}`);   ipc({ type: "log", level: "warn",  id: currentStepId, line: m }); };
const fail = (m) => {
  if (!IPC) console.error(`[error] ${m}`);
  ipc({ type: "log", level: "error", id: currentStepId, line: m });
  if (currentStepId) ipc({ type: "step", id: currentStepId, state: "error", message: m });
  ipc({ type: "fatal", message: m });
  process.exit(1);
};

// Collapse captured child output into clean log lines for the IPC stream.
// npm and ollama animate their progress bars with bare carriage returns
// (`\r`, no newline) — redrawing one physical line dozens-to-hundreds of
// times. A naive `/\r?\n/` split treats that whole burst as a SINGLE line,
// so every redraw frame's █ ▒ ░ block glyphs concatenate into one giant
// wall of symbols in the GUI's details view (the live symptom on macOS).
// Normalize CRLF first so real Windows newlines are preserved, then for any
// line that still contains a bare `\r`, keep only the final frame — the last
// rendered state of that animation (e.g. the "100%" bar), dropping the rest.
function cleanLines(raw) {
  const out = [];
  for (const physical of (raw || "").replace(/\r\n/g, "\n").split("\n")) {
    const frame = physical.includes("\r")
      ? physical.slice(physical.lastIndexOf("\r") + 1)
      : physical;
    if (frame.trim()) out.push(frame);
  }
  return out;
}

// In IPC mode child process stdout would corrupt the JSONL stream if it
// inherited the terminal. Capture stdout/stderr into memory and emit each
// non-empty line as a {type:"log"} event tagged with the current step.
// Prose mode keeps stdio:"inherit" so users see real-time output (which
// for slow steps like VS Build Tools is the only feedback they get).
function run(cmd, args, opts = {}) {
  if (!IPC) {
    return spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  }
  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    encoding: "utf-8",
    ...opts,
  });
  for (const line of cleanLines(result.stdout)) {
    ipc({ type: "log", level: "info", id: currentStepId, line });
  }
  for (const line of cleanLines(result.stderr)) {
    ipc({ type: "log", level: "warn", id: currentStepId, line });
  }
  return result;
}

// Pull a percentage out of a progress line to drive the GUI's live bar.
// npm/ollama/electron-builder all print a trailing "NN%" (ollama:
// "pulling a1b2…  37% ▕███▏ 250/670 MB"). Take the LAST match on the frame
// so the most-recent number wins; clamp to 0-100. Returns null when absent.
function parsePercent(line) {
  const matches = line.match(/(\d{1,3})\s*%/g);
  if (!matches) return null;
  const n = parseInt(matches[matches.length - 1], 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

// Streaming sibling of run() for the long steps (npm install, ollama pull,
// electron-builder). spawnSync buffers everything and only emits on exit, so
// the GUI sits silent for minutes then dumps a wall of text; this streams
// stdout/stderr live. It breaks on BOTH \r and \n so each carriage-return
// animation frame is its own line (no symbol-wall pile-up), forwards the
// final rendered frame, and emits {type:"progress",percent} so the installer
// drives a real percentage bar. Returns a spawnSync-shaped {status} so
// callers keep checking `.status !== 0` unchanged. Prose mode is untouched.
function runStreaming(cmd, args, opts = {}) {
  if (!IPC) {
    return Promise.resolve(
      spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts }),
    );
  }
  return new Promise((resolve) => {
    const stepId = currentStepId;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...opts,
    });
    let lastPct = -1;
    const bufs = { info: "", warn: "" };
    const pump = (level, text) => {
      const t = text.trim();
      if (!t) return;
      ipc({ type: "log", level, id: stepId, line: t });
      const pct = parsePercent(t);
      if (pct !== null && pct !== lastPct) {
        lastPct = pct;
        ipc({ type: "progress", id: stepId, percent: pct });
      }
    };
    const sink = (level) => (chunk) => {
      bufs[level] += chunk.toString("utf-8");
      let idx;
      while ((idx = bufs[level].search(/[\r\n]/)) !== -1) {
        pump(level, bufs[level].slice(0, idx));
        bufs[level] = bufs[level].slice(idx + 1);
      }
    };
    child.stdout?.on("data", sink("info"));
    child.stderr?.on("data", sink("warn"));
    child.on("error", (err) => {
      pump("warn", String(err?.message || err));
      resolve({ status: -1, error: err });
    });
    child.on("close", (code) => {
      // Flush trailing partials that never hit a delimiter.
      pump("info", bufs.info); bufs.info = "";
      pump("warn", bufs.warn); bufs.warn = "";
      resolve({ status: code ?? -1 });
    });
  });
}
function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore", shell: true }).status === 0;
}

// On Windows a freshly winget-installed Ollama lands in
// %LOCALAPPDATA%\Programs\Ollama and updates the *persisted* user PATH — but
// this already-running install process captured its PATH at launch, so a later
// has("ollama") / `ollama pull` in the SAME run can't find it. The result: the
// embedmodel step takes its "Ollama not on PATH" branch and the embedding model
// silently never downloads (the live symptom on fresh Windows installs).
// Prepend the known install dir to THIS process's PATH so the rest of the run
// can use ollama immediately. (install.ps1 does the same for Node.) No-op off
// Windows, if the dir is absent, or if it's already on PATH.
function ensureOllamaOnPath() {
  if (process.platform !== "win32") return;
  const dir = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "Ollama");
  const parts = (process.env.PATH || "").split(";");
  if (existsSync(dir) && !parts.includes(dir)) {
    process.env.PATH = `${dir};${process.env.PATH || ""}`;
  }
}

// Cross-platform "stop any running `ollama serve`". pkill is Unix-only and is a
// silent no-op on Windows, which left the daemon-restart + pull-retry paths
// dead there; Windows kills the ollama.exe tree via taskkill instead.
function killOllamaServe() {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/IM", "ollama.exe", "/T"], { stdio: "ignore", shell: true });
  } else {
    spawnSync("pkill", ["-f", "ollama serve"], { stdio: "ignore" });
  }
}

// Emit the plan once, before any step starts.
ipc({ type: "plan", steps: STEPS_PLAN });

// 1. Node version assertion
step("node");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < NODE_MAJOR_MIN) {
  fail(`Node ${NODE_MAJOR_MIN}+ required (found v${process.versions.node})`);
}
ok(`Node v${process.versions.node}`);
stepDone("node");

// 1a. C++ build tools — required for native npm modules (better-sqlite3,
//     sherpa-onnx, etc.) when they fall back to source build. Phase 2 of the
//     installer-UX refactor moved this from install.bat / install.sh into here
//     so the JSONL stream covers it and the GUI installer can show a step
//     instead of a raw cmd window during the slow winget run.
//
//     Windows: vswhere detects existing install, winget installs the
//       VC.Tools.x86.x64 workload silently. ~3 GB download, 10-30 min.
//     macOS:   xcode-select -p detects existing install; --install opens
//       a system dialog the user must click through (Apple doesn't provide
//       unattended CLT install). Polls for completion.
//     Linux:   apt build-essential.
if (process.platform === "win32") {
  step("vsbuildtools", "~3 GB download, 10-30 min on first install");
  const vswhere = `${process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  let hasVc = false;
  if (existsSync(vswhere)) {
    const r = spawnSync(vswhere, [
      "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property", "installationPath",
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    hasVc = r.status === 0 && (r.stdout || "").trim().length > 0;
  }
  if (hasVc) {
    ok("Visual Studio Build Tools already present");
  } else {
    log("Installing Visual Studio Build Tools (silent winget)…");
    const r = run("winget", [
      "install", "--id", "Microsoft.VisualStudio.2022.BuildTools",
      "--accept-package-agreements", "--accept-source-agreements",
      "--silent", "--disable-interactivity",
      "--override", "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended",
    ]);
    // winget returns 0x8A150011 = "no applicable upgrade found" if Build
    // Tools is already at latest; treat that as success. Anything else
    // non-zero is a real failure.
    if (r.status !== 0 && r.status !== -1978335215) {
      fail(`winget install BuildTools failed (exit ${r.status}). Re-run installer or install manually from https://visualstudio.microsoft.com/downloads/`);
    }
    ok("Visual Studio Build Tools installed");
  }
  stepDone("vsbuildtools");
} else if (process.platform === "darwin") {
  step("xcode-clt", "Apple requires a system dialog — click Install if prompted");
  const cltCheck = spawnSync("xcode-select", ["-p"], { stdio: ["ignore", "ignore", "ignore"] });
  if (cltCheck.status === 0) {
    ok("Xcode Command Line Tools already present");
  } else {
    log("Triggering Xcode CLT install (system dialog opens)…");
    // xcode-select --install spawns a system dialog and returns
    // immediately. Poll xcode-select -p for completion. Apple offers no
    // unattended path; the user must click through the dialog.
    spawnSync("xcode-select", ["--install"], { stdio: ["ignore", "ignore", "ignore"] });
    const deadline = Date.now() + 30 * 60 * 1000;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      if (spawnSync("xcode-select", ["-p"], { stdio: ["ignore", "ignore", "ignore"] }).status === 0) {
        done = true; break;
      }
    }
    if (!done) fail("Xcode CLT install didn't complete within 30 min. Click 'Install' in the system dialog and re-run.");
    ok("Xcode Command Line Tools installed");
  }
  stepDone("xcode-clt");
} else if (process.platform === "linux") {
  // Linux build-essential — gated under the "python" step's existing path
  // to keep the step count stable; revisit if Linux usage grows.
}

// 1b. Python 3.12 — optional for voice servers + user scripts, but the user
//     base widely expects it so we install it by default.
step("python");
const pyOk = (() => {
  // python3 on darwin/linux, python on win32
  const cmd = process.platform === "win32" ? "python" : "python3";
  return spawnSync(cmd, ["--version"], { stdio: ["ignore", "ignore", "ignore"], shell: true }).status === 0;
})();
if (pyOk) {
  ok("Python already present");
} else {
  log("Installing Python 3.12…");
  if (process.platform === "win32") {
    const r = run("winget", ["install", "Python.Python.3.12", "--accept-package-agreements", "--accept-source-agreements", "--silent"]);
    if (r.status !== 0) warn(`Python install failed (exit ${r.status}) — continuing without (voice servers won't work)`);
    else ok("Python 3.12 installed");
  } else if (process.platform === "darwin") {
    const r = run("brew", ["install", "python@3.12"]);
    if (r.status !== 0) warn(`Python install failed — continuing without (voice servers won't work)`);
    else ok("Python 3.12 installed");
  } else {
    const r = run("sudo", ["apt-get", "install", "-y", "python3", "python3-pip"]);
    if (r.status !== 0) warn(`Python install failed — continuing without (voice servers won't work)`);
    else ok("Python installed");
  }
}
stepDone("python");

// 1c. Ollama runtime — separate from the embed-model pull below. Installing
//     Ollama is the bootstrap; pulling the model is what makes it usable.
step("ollama");
if (has("ollama")) {
  ok("Ollama already present");
} else {
  log("Installing Ollama…");
  if (process.platform === "win32") {
    const r = run("winget", ["install", "Ollama.Ollama", "--accept-package-agreements", "--accept-source-agreements", "--silent"]);
    if (r.status !== 0) fail(`Ollama install failed (exit ${r.status}). Install manually from https://ollama.com/download`);
    ensureOllamaOnPath(); // make the just-installed ollama visible to this run
    ok("Ollama installed");
  } else if (process.platform === "darwin") {
    const r = run("brew", ["install", "ollama"]);
    if (r.status !== 0) fail("Ollama install failed. Install manually from https://ollama.com/download");
    ok("Ollama installed");
  } else {
    // Linux: pipe Ollama's official install script through sh. Trust the
    // ollama.com source the same way the upstream README tells users to.
    const r = spawnSync("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { stdio: IPC ? ["ignore", "pipe", "pipe"] : "inherit" });
    if (r.status !== 0) fail("Ollama install failed. Install manually from https://ollama.com/download");
    ok("Ollama installed");
  }
}
stepDone("ollama");

// 2. npm install — retry with legacy peer deps on first failure.
// --loglevel=error hides the transitive-dep deprecation warnings (inflight,
// lodash.isequal, rimraf@2, glob@7, etc.) that come from sub-deps we don't
// directly control. Real errors still surface (npm prints those at error
// level regardless of --loglevel). If a user needs the full output for
// debugging, they can rerun with LAX_NPM_LOGLEVEL=warn.
const npmLogLevel = process.env.LAX_NPM_LOGLEVEL || "error";
step("npm", "npm install (5-10 min on first install)");
log("Installing npm dependencies…");
let res = await runStreaming("npm", ["install", "--no-audit", "--no-fund", `--loglevel=${npmLogLevel}`]);
if (res.status !== 0) {
  warn("First attempt failed. Retrying with --legacy-peer-deps…");
  res = await runStreaming("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    `--loglevel=${npmLogLevel}`,
    "--legacy-peer-deps",
  ]);
  if (res.status !== 0) fail("npm install failed. See errors above.");
}

// Native modules (better-sqlite3 + onnxruntime-node) embed a NODE_MODULE_VERSION
// in their compiled .node binary that has to match the running Node's ABI.
// When the host upgrades Node (or we wipe Node 25 → install Node 22), `npm
// install` sees node_modules is "complete" and skips the rebuild — leaving
// stale binaries that crash the server on first import. `npm rebuild`
// forces a recompile against the current Node. Idempotent + fast when
// already correct (~2-5s); only does real work when a mismatch exists.
//
// Specifically targeting better-sqlite3 keeps the rebuild scoped — a full
// `npm rebuild` would unnecessarily recompile every package's prepublish
// scripts and balloon install time.
log("Verifying native module ABI…");
const rebuildRes = run("npm", [
  "rebuild",
  "better-sqlite3",
  "--no-audit",
  "--no-fund",
  `--loglevel=${npmLogLevel}`,
]);
if (rebuildRes.status !== 0) {
  // Non-fatal: if rebuild fails we still try to continue. The server
  // import will crash with a clearer error than we'd produce from here.
  warn("npm rebuild better-sqlite3 returned non-zero; continuing");
}

ok("npm dependencies installed");
stepDone("npm");

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
const OLLAMA_URL = process.env.LAX_OLLAMA_URL || "http://127.0.0.1:11434";
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
    killOllamaServe();
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
step("embedmodel", `Downloading ${EMBED_MODEL} (~670 MB, one-time)`);
ensureOllamaOnPath(); // defensive: cover an install done in a prior run this process can't see
if (has("ollama")) {
  const ready = await ensureOllamaUp();
  if (!ready) {
    warn(`Ollama daemon didn't come up at ${OLLAMA_URL} — skipping model pull. Re-run later: ollama pull ${EMBED_MODEL}`);
  } else {
    log(`Pulling ${EMBED_MODEL} (~670MB, one-time)…`);
    let pull = await runStreaming("ollama", ["pull", EMBED_MODEL]);
    // One retry on transient registry/keypair errors. spawn returns the
    // child's exit code; ollama exits non-zero on any pull failure, so
    // restart-then-retry is safe even when the first try succeeded
    // partially (pulls are resumable + content-addressed).
    if (pull.status !== 0) {
      warn("Pull failed on first attempt — restarting daemon and retrying once…");
      killOllamaServe();
      await new Promise(r => setTimeout(r, 2000));
      const { spawn } = await import("node:child_process");
      spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        if (await ollamaReady()) break;
      }
      pull = await runStreaming("ollama", ["pull", EMBED_MODEL]);
    }
    if (pull.status === 0) ok("Memory engine ready");
    else warn(`Pull failed twice — semantic memory unavailable. Re-run later: ollama pull ${EMBED_MODEL}`);
  }
} else {
  warn(`Ollama not on PATH — semantic memory will be unavailable until you install Ollama and run: ollama pull ${EMBED_MODEL}`);
}
stepDone("embedmodel");

// 4. Default settings scaffold (~/.lax/settings.json).
step("settings");
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
stepDone("settings");

// 5. Production build of the server — FAIL-CLOSED. tsc failures most
//    often signal a broken AriKernel contract (the security/policy gate
//    the runtime hard-requires). We refuse to ship an install that papers
//    over those errors, even though the .app technically has a tsx
//    fallback for dist/-missing cases — a broken build is a signal worth
//    stopping for, not silencing.
step("build", "tsc + arikernel (1-2 min)");
log("Building server (npm run build)…");
res = await runStreaming("npm", ["run", "build"]);
if (res.status !== 0) fail("npm run build failed. Fix the build errors above before re-running install — the runtime refuses to boot when its security layer (AriKernel pre-dispatch gate) can't wire.");
ok("Server build complete");
stepDone("build");

// 6. ~/.lax/config.json — packaged Electron reads projectRoot from here so
step("config");
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
stepDone("config");

// 7. macOS: build the Mac .app and install it to /Applications.
step("desktop", process.platform === "darwin" ? "Electron .app build (~3–5 min)" : process.platform === "win32" ? "Electron desktop bundle build" : null);
//    Set LAX_SKIP_APP=1 to skip (useful for headless dev iteration).
let appInstalled = false;
let appBuildPath = null;
if (process.platform === "darwin" && !process.env.LAX_SKIP_APP) {
  log("Building Local Agent X.app — this is the slow step the first time (~3–5 min, ~500MB).");

  let r = await runStreaming(
    "npm",
    ["install", "--no-audit", "--no-fund", `--loglevel=${npmLogLevel}`],
    { cwd: "desktop" },
  );
  if (r.status !== 0) fail("desktop npm install failed.");

  r = await runStreaming("npm", ["run", "build"], { cwd: "desktop" });
  if (r.status !== 0) fail("desktop tsc build failed.");

  r = await runStreaming("npm", ["run", "dist"], { cwd: "desktop" });
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
} else if (process.platform === "win32" && !process.env.LAX_SKIP_APP) {
  // Build the Electron desktop subproject so desktop-launch.bat actually
  // launches something. The .bat invokes desktop/node_modules/.bin/electron.cmd
  // with desktop/dist/main.js — both produced here. We skip electron-builder
  // (npm run dist) since the .bat invokes electron directly from the repo
  // checkout, no packaged .exe needed. Live failure 2026-05-18: install
  // completed and created shortcuts, but double-clicking either shortcut
  // exited in milliseconds because dist/main.js + electron.cmd didn't exist.
  log("Building Electron desktop bundle…");
  let dr = await runStreaming(
    "npm",
    ["install", "--no-audit", "--no-fund", `--loglevel=${npmLogLevel}`],
    { cwd: "desktop" },
  );
  if (dr.status !== 0) fail("desktop npm install failed.");
  dr = await runStreaming("npm", ["run", "build"], { cwd: "desktop" });
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
  // Launch dist/loader.js, NOT dist/main.js. loader.js calls app.setName(
  // "Local Agent X") before Electron resolves the userData path; main.js does
  // not, so launching it directly makes Electron fall back to the default
  // "electron" app name and land localStorage/IndexedDB at %APPDATA%\electron\
  // instead of %APPDATA%\Local Agent X\. (loader.js then require()s main.js.)
  const entryJs = join(repoRoot, "desktop", "dist", "loader.js");
  const workDir = join(repoRoot, "desktop");
  const iconPath = join(repoRoot, "public", "icon.ico");
  if (!existsSync(electronExe) || !existsSync(entryJs)) {
    warn(`Desktop build artifacts missing (${electronExe} or ${entryJs}) — skipping shortcut creation`);
  } else {
    // Single-quoted PowerShell strings: backslashes literal, no var
    // interpolation. Apostrophes in usernames would break this; PS doesn't
    // support a clean escape inside single-quoted literals other than ''
    // doubling — accept that as an unlikely edge case rather than complicate.
    const psElectron = electronExe.replace(/'/g, "''");
    const psEntry = entryJs.replace(/'/g, "''");
    const psWork = workDir.replace(/'/g, "''");
    const psIcon = existsSync(iconPath) ? iconPath.replace(/'/g, "''") : "";
    const ps = [
      `$electron = '${psElectron}'`,
      `$entryJs  = '${psEntry}'`,
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
      `  $s.Arguments = '"' + $entryJs + '"'`,
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

  // Register an Add/Remove Programs entry (Settings → Installed apps) so users
  // can uninstall cleanly instead of hunting down folders. Standalone installs
  // only — a dev clone (.git present) must never get an uninstaller that would
  // delete the repo. Writes uninstall.ps1 into the install dir and points the
  // HKCU UninstallString at it (per-user, no admin needed).
  if (!existsSync(join(repoRoot, ".git"))) {
    try {
      const appVersion = (() => { try { return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version || "0.0.0"; } catch { return "0.0.0"; } })();
      const uninstallPs1 = join(repoRoot, "uninstall.ps1");
      writeFileSync(uninstallPs1, UNINSTALL_PS1.replace(/__INSTALL_DIR__/g, repoRoot.replace(/'/g, "''")));
      const iconIco = join(repoRoot, "public", "icon.ico");
      const dispIcon = existsSync(iconIco) ? iconIco : electronExe;
      const uninstallCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${uninstallPs1}"`;
      const q = (s) => String(s).replace(/'/g, "''");
      const regPs = [
        `$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LocalAgentX'`,
        `New-Item -Path $k -Force | Out-Null`,
        `Set-ItemProperty $k DisplayName 'Local Agent X'`,
        `Set-ItemProperty $k DisplayIcon '${q(dispIcon)}'`,
        `Set-ItemProperty $k DisplayVersion '${q(appVersion)}'`,
        `Set-ItemProperty $k Publisher 'Local Agent X'`,
        `Set-ItemProperty $k InstallLocation '${q(repoRoot)}'`,
        `Set-ItemProperty $k UninstallString '${q(uninstallCmd)}'`,
        `Set-ItemProperty $k NoModify 1 -Type DWord`,
        `Set-ItemProperty $k NoRepair 1 -Type DWord`,
      ].join("; ");
      const rr = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", regPs], { stdio: IPC ? ["ignore", "pipe", "pipe"] : "inherit" });
      if (rr.status === 0) ok("Registered uninstaller — Settings → Installed apps → Local Agent X");
      else warn(`Uninstaller registration failed (exit ${rr.status}); manual folder removal still works`);
    } catch (e) {
      warn(`Uninstaller registration skipped: ${e.message}`);
    }
  }
} else if (process.platform === "linux") {
  log("(Linux: no native app target yet — use `npm run dev` to launch the server.)");
}
stepDone("desktop");

ipc({ type: "complete" });
if (!IPC) console.log("");
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
