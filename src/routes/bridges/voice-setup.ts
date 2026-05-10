import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";
import { createLogger } from "../../logger.js";
import { kokoroVoiceList, tier4Readiness } from "../../voice/tier4/index.js";

const logger = createLogger("routes.bridges.voice-setup");

interface VoiceTier {
  id: string;
  label: string;
  port: number;
  venvDir: string;        // installation marker
  installerPath: string;  // PS1 installer (Windows) — null if no installer
  startCmd: () => { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  healthUrl: string;
  description: string;
  diskFootprint: string;
  // "native" tiers run in-process (no Python sidecar). install/start/stop
  // routes are inert for them; status comes from a readiness probe instead
  // of /healthz. Defaults to "sidecar" for back-compat with existing tiers.
  kind?: "sidecar" | "native";
}

const REPO_ROOT = resolve(process.cwd());
const HOME = homedir();
const IS_WIN = platform() === "win32";
const PYTHON_EXE = IS_WIN ? "Scripts/python.exe" : "bin/python";

const TIERS: VoiceTier[] = [
  {
    id: "lite",
    label: "Lite (GPU sidecar)",
    port: Number(process.env.LAX_VOICE_PORT) || 7008,
    venvDir: join(HOME, ".lax", "python-voice", "venv"),
    installerPath: join(REPO_ROOT, "python", "voice", "install.ps1"),
    startCmd: () => ({
      command: join(HOME, ".lax", "python-voice", "venv", PYTHON_EXE),
      args: [join(REPO_ROOT, "python", "voice", "server.py")],
      env: { ...process.env, LAX_VOICE_PORT: String(Number(process.env.LAX_VOICE_PORT) || 7008) },
    }),
    healthUrl: `http://127.0.0.1:${process.env.LAX_VOICE_PORT || "7008"}/healthz`,
    description: "faster-whisper STT + Kokoro TTS + Silero VAD. Built-in voices, GPU-accelerated streaming.",
    diskFootprint: "~3–4 GB",
  },
  {
    id: "studio",
    label: "Studio (Chatterbox)",
    port: Number(process.env.LAX_CHATTERBOX_PORT) || 7010,
    venvDir: join(HOME, ".lax", "python-chatterbox", "venv"),
    installerPath: join(REPO_ROOT, "python", "chatterbox", "install.ps1"),
    // Note: invoked as `server:app` with --app-dir pointing at our local
    // chatterbox/ directory, NOT as `chatterbox.server:app`. The venv has
    // the upstream `chatterbox-tts` pip package which exposes `chatterbox.
    // ChatterboxTTS`; if we treat our local dir as a `chatterbox` package
    // (e.g. by adding __init__.py) we shadow that import and the sidecar
    // crashes with `cannot import name 'ChatterboxTTS' from 'chatterbox'`.
    startCmd: () => ({
      command: join(HOME, ".lax", "python-chatterbox", "venv", PYTHON_EXE),
      args: ["-m", "uvicorn", "server:app", "--app-dir", join(REPO_ROOT, "python", "chatterbox"), "--host", "127.0.0.1", "--port", String(Number(process.env.LAX_CHATTERBOX_PORT) || 7010)],
      cwd: join(REPO_ROOT, "python"),
      env: { ...process.env },
    }),
    healthUrl: `http://127.0.0.1:${process.env.LAX_CHATTERBOX_PORT || "7010"}/healthz`,
    description: "Chatterbox Turbo high-quality TTS with reference-clip voice cloning. ~200ms per chunk.",
    diskFootprint: "~3–5 GB (model auto-downloads on first use)",
  },
  {
    id: "studio-trained",
    label: "Studio-Trained (GPT-SoVITS)",
    port: Number(process.env.LAX_SOVITS_PORT) || 7012,
    venvDir: join(HOME, ".lax", "sovits", "venv"),
    // The installer rebuilds the venv on top of an existing GPT-SoVITS
    // checkout (~/.lax/sovits/repo). Trained voice weights survive a venv
    // wipe but the picker said "Not installed" with no recovery path —
    // this is the recovery path. If the repo isn't present, the installer
    // exits cleanly with instructions to run the training pipeline first.
    installerPath: join(REPO_ROOT, "python", "sovits", "install.ps1"),
    startCmd: () => ({
      command: join(HOME, ".lax", "sovits", "venv", PYTHON_EXE),
      args: [join(REPO_ROOT, "python", "sovits", "server.py")],
      cwd: join(REPO_ROOT, "python", "sovits"),
      env: { ...process.env },
    }),
    healthUrl: `http://127.0.0.1:${process.env.LAX_SOVITS_PORT || "7012"}/healthz`,
    description: "Fine-tuned voice cloning via GPT-SoVITS v2Pro. Train your own voices (~30–45 min on RTX 3060).",
    diskFootprint: "~5 GB (per trained voice: ~50–100 MB)",
  },
  {
    id: "native",
    label: "Native ONNX (Kokoro)",
    kind: "native",
    port: 0,
    venvDir: "",
    installerPath: "",
    startCmd: () => ({ command: "", args: [] }),
    healthUrl: "",
    description: "Tier 4 — in-process Kokoro-82M (ONNX). No Python sidecar; uses DirectML/CPU. ~1s first audio, RTF 0.4 on RTX 3060.",
    diskFootprint: "~80 MB (auto-downloads on first use)",
  },
];

const tierById = (id: string) => TIERS.find(t => t.id === id);

// ── Process tracking ────────────────────────────────────────────────────────
const running: Map<string, ChildProcess> = new Map();

/**
 * Start one tier's sidecar and block until /healthz reports OK or the
 * 3-min deadline passes. Returns true on healthy start, false on timeout.
 * Extracted from the start-route handler so it can be reused as a prereq
 * step (Studio / SoVITS auto-start Lite first).
 */
async function startTierAndWait(tier: VoiceTier): Promise<boolean> {
  killTier(tier.id);
  const cmd = tier.startCmd();
  logger.info(`[voice-setup] Starting ${tier.id}: ${cmd.command} ${cmd.args.join(" ")}`);
  const proc = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
  });
  running.set(tier.id, proc);
  proc.stdout?.on("data", c => logger.info(`[${tier.id}] ${c.toString().trim().slice(0, 300)}`));
  proc.stderr?.on("data", c => logger.info(`[${tier.id}] ${c.toString().trim().slice(0, 300)}`));
  proc.on("exit", code => { logger.info(`[voice-setup] ${tier.id} exited (${code})`); if (running.get(tier.id) === proc) running.delete(tier.id); });
  // Cold-start is heavy: faster-whisper large-v3-turbo + Kokoro + Silero
  // VAD on first CUDA load can take 90-120s. Subsequent starts after OS
  // file cache is warm are <20s.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    const h = await probeHealth(tier.healthUrl);
    if (h.ok) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function killTier(tierId: string): void {
  const proc = running.get(tierId);
  if (proc && proc.exitCode === null) {
    try { proc.kill(); } catch {}
  }
  running.delete(tierId);
}

// Kill all on server shutdown.
process.on("exit", () => { for (const id of running.keys()) killTier(id); });
process.on("SIGINT", () => { for (const id of running.keys()) killTier(id); process.exit(0); });
process.on("SIGTERM", () => { for (const id of running.keys()) killTier(id); process.exit(0); });

// ── Detection ───────────────────────────────────────────────────────────────
function isInstalled(tier: VoiceTier): boolean {
  return existsSync(join(tier.venvDir, PYTHON_EXE));
}

// Studio-trained-specific: detect partial state where the GPT-SoVITS repo
// + trained voice weights are on disk but the venv isn't. This is the
// "venv got wiped, weights survived" state — picker shows "Weights present,
// click Rebuild" instead of the misleading "Not installed".
function studioTrainedAssetState(): { repoPresent: boolean; weightsPresent: boolean } {
  const repoDir = join(HOME, ".lax", "sovits", "repo");
  const repoPresent = existsSync(repoDir);
  if (!repoPresent) return { repoPresent: false, weightsPresent: false };
  // Any *.pth file in the SoVITS_weights* sibling dirs counts as a trained voice.
  const weightDirs = ["SoVITS_weights", "SoVITS_weights_v2", "SoVITS_weights_v2Pro", "SoVITS_weights_v2ProPlus", "SoVITS_weights_v3", "SoVITS_weights_v4"];
  let weightsPresent = false;
  for (const d of weightDirs) {
    const candidate = join(repoDir, d);
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isDirectory()) continue;
      const items = readdirSync(candidate);
      if (items.some(name => name.toLowerCase().endsWith(".pth"))) {
        weightsPresent = true;
        break;
      }
    } catch { /* ignore unreadable dirs */ }
  }
  return { repoPresent, weightsPresent };
}

async function probeHealth(url: string): Promise<{ ok: boolean; ready?: boolean; payload?: unknown }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { ok: false };
    const payload = await r.json().catch(() => ({}));
    return { ok: true, ready: !!(payload as Record<string, unknown>).ready, payload };
  } catch { return { ok: false }; }
}

async function tierStatus(tier: VoiceTier) {
  if (tier.kind === "native") {
    const { tier4Readiness, tier4ModelDownloaded } = await import("../../voice/tier4/index.js");
    const r = tier4Readiness();
    const m = await tier4ModelDownloaded();
    return {
      id: tier.id,
      label: tier.label,
      port: 0,
      kind: "native" as const,
      description: tier.description,
      diskFootprint: tier.diskFootprint,
      installed: r.ready,           // "installed" == npm deps resolvable
      hasInstaller: false,          // npm install handles it
      running: r.ready && m.cached, // model present means ready to use
      healthy: r.ready && m.cached, // no /healthz to probe
      pid: null,
      healthPayload: {
        modelId: r.defaultModelId,
        defaultVoice: r.defaultVoice,
        defaultDevice: r.defaultDevice,
        requestedDevice: r.requestedDevice,
        requestedDtype: r.requestedDtype,
        modelCached: m.cached,
        approxBytes: m.approxBytes,
        reason: r.reason,
      },
    };
  }

  const installed = isInstalled(tier);
  const proc = running.get(tier.id);
  const trackedRunning = !!(proc && proc.exitCode === null);
  const health = installed ? await probeHealth(tier.healthUrl) : { ok: false };
  // Studio-trained gets extra fields so the picker can distinguish:
  //   - venv missing + weights present → "Weights found, click Install to rebuild"
  //   - venv missing + no weights      → "Not installed (run training pipeline)"
  // For other tiers, leave undefined.
  const studioAssets = tier.id === "studio-trained" ? studioTrainedAssetState() : undefined;
  return {
    id: tier.id,
    label: tier.label,
    port: tier.port,
    description: tier.description,
    diskFootprint: tier.diskFootprint,
    installed,
    hasInstaller: !!tier.installerPath && existsSync(tier.installerPath),
    running: trackedRunning || health.ok,
    healthy: !!health.ok && !!health.ready,
    pid: proc?.pid || null,
    healthPayload: health.payload || null,
    ...(studioAssets ? { repoPresent: studioAssets.repoPresent, weightsPresent: studioAssets.weightsPresent } : {}),
  };
}

// ── Npm dep probe ───────────────────────────────────────────────────────────
// Cheap "is this package on disk" check for voice-tier deps that aren't
// gated through a sidecar tier (i.e. msedge-tts, mpg123-decoder for the
// Edge cloud tier). The voice-picker UI used to render "Assumed installed"
// for these, which was misleading — this gives the picker real signal so
// users see "Installed" with a version, or "Missing — run npm install".
const VOICE_NPM_PACKAGES = ["msedge-tts", "mpg123-decoder"] as const;

function probeVoiceNpmDeps(): Record<string, { installed: boolean; version?: string }> {
  const out: Record<string, { installed: boolean; version?: string }> = {};
  for (const pkg of VOICE_NPM_PACKAGES) {
    const pkgJsonPath = join(REPO_ROOT, "node_modules", pkg, "package.json");
    if (!existsSync(pkgJsonPath)) {
      out[pkg] = { installed: false };
      continue;
    }
    try {
      const j = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
      out[pkg] = { installed: true, version: j.version };
    } catch {
      out[pkg] = { installed: true };
    }
  }
  return out;
}

// ── Routes ──────────────────────────────────────────────────────────────────
export const handleVoiceSetupRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/voices/setup/status") {
    const tiers = await Promise.all(TIERS.map(tierStatus));
    json(200, { platform: platform(), tiers, npm: probeVoiceNpmDeps() });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/voices/setup/install") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const tierId = String((body as { tier?: string }).tier || "");
      const tier = tierById(tierId);
      if (!tier) { json(400, { error: `Unknown tier: ${tierId}` }); return true; }
      if (tier.kind === "native") {
        json(400, { error: "Tier 4 native is provisioned via npm install — no install/start/stop needed." }); return true;
      }
      if (!tier.installerPath || !existsSync(tier.installerPath)) {
        json(400, { error: `No installer for ${tier.label}. See docs.` }); return true;
      }
      if (!IS_WIN) { json(400, { error: "Installer is PowerShell; non-Windows not yet supported." }); return true; }

      logger.info(`[voice-setup] Installing ${tier.id} via ${tier.installerPath}`);
      const proc = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", tier.installerPath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      proc.stdout?.on("data", c => { out += c.toString(); });
      proc.stderr?.on("data", c => { out += c.toString(); });
      const exitCode: number = await new Promise(r => proc.on("exit", code => r(code ?? -1)));
      const ok = exitCode === 0 && isInstalled(tier);
      if (ok) logger.info(`[voice-setup] ${tier.id} installed (exit ${exitCode})`);
      else logger.warn(`[voice-setup] ${tier.id} install failed (exit ${exitCode})`);
      json(ok ? 200 : 500, { ok, exitCode, output: out.slice(-4000) });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/voices/setup/start") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const tierId = String((body as { tier?: string }).tier || "");
      const tier = tierById(tierId);
      if (!tier) { json(400, { error: `Unknown tier: ${tierId}` }); return true; }
      if (tier.kind === "native") {
        json(400, { error: "Tier 4 native runs in-process — no sidecar to start." }); return true;
      }
      if (!isInstalled(tier)) { json(400, { error: `${tier.label} is not installed yet.` }); return true; }

      // Studio (Chatterbox) and Studio-Trained (SoVITS) are clone WORKERS —
      // they synthesize from reference clips but have no STT, no VAD, and
      // no internal routing. Lite is the API frontdoor that web voice mode
      // talks to over WS, and Lite proxies trained/clone synth requests
      // INTO Studio/SoVITS at synth time. Starting Studio without Lite
      // gives you a worker with nothing to dispatch to it. Auto-start
      // Lite as a hard prereq so the user doesn't have to remember the
      // dependency order. Skipped if Lite isn't installed (no recovery
      // path from here — surface that as a clear error).
      if (tier.id === "studio" || tier.id === "studio-trained") {
        const lite = tierById("lite");
        if (lite && isInstalled(lite)) {
          const lh = await probeHealth(lite.healthUrl);
          if (!lh.ok) {
            const ok = await startTierAndWait(lite);
            if (!ok) {
              json(502, { error: `${tier.label} requires Lite as a dispatcher, but Lite failed to start. Open the Lite card and start it manually to see the error.` });
              return true;
            }
            logger.info(`[voice-setup] auto-started Lite as prereq for ${tier.id}`);
          }
        } else if (lite && !isInstalled(lite)) {
          json(400, { error: `${tier.label} requires Lite as a dispatcher. Lite isn't installed yet — install it first.` });
          return true;
        }
      }

      // Already up?
      const existingHealth = await probeHealth(tier.healthUrl);
      if (existingHealth.ok) { json(200, { ok: true, already: true, healthPayload: existingHealth.payload }); return true; }

      const ok = await startTierAndWait(tier);
      if (!ok) {
        const proc = running.get(tier.id);
        json(504, { error: `${tier.label} didn't report healthy within 3 min — but pid ${proc?.pid ?? "?"} is still running. Cold-start can be slow; try clicking Start again in 30s, or check logs.` });
        return true;
      }
      const proc = running.get(tier.id);
      json(200, { ok: true, pid: proc?.pid });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/voices/setup/stop") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const tierId = String((body as { tier?: string }).tier || "");
      const tier = tierById(tierId);
      if (!tier) { json(400, { error: `Unknown tier: ${tierId}` }); return true; }
      if (tier.kind === "native") {
        json(400, { error: "Tier 4 native runs in-process — nothing to stop." }); return true;
      }
      killTier(tier.id);
      json(200, { ok: true });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/voice/tier4/voices") {
    try {
      json(200, { default: tier4Readiness().defaultVoice, voices: kokoroVoiceList() });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
