import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";
import { createLogger } from "../../logger.js";

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
    startCmd: () => ({
      command: join(HOME, ".lax", "python-chatterbox", "venv", PYTHON_EXE),
      args: ["-m", "uvicorn", "chatterbox.server:app", "--host", "127.0.0.1", "--port", String(Number(process.env.LAX_CHATTERBOX_PORT) || 7010)],
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
    installerPath: "", // no one-click installer — training pipeline drives setup
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
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────
export const handleVoiceSetupRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/voices/setup/status") {
    const tiers = await Promise.all(TIERS.map(tierStatus));
    json(200, { platform: platform(), tiers });
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

      // Already up?
      const existingHealth = await probeHealth(tier.healthUrl);
      if (existingHealth.ok) { json(200, { ok: true, already: true, healthPayload: existingHealth.payload }); return true; }

      // Kill any tracked-but-dead process
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

      // Wait up to 60s for /healthz to come up.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) { json(500, { error: `${tier.label} exited during startup (code ${proc.exitCode})` }); return true; }
        const h = await probeHealth(tier.healthUrl);
        if (h.ok) { json(200, { ok: true, pid: proc.pid, healthPayload: h.payload }); return true; }
        await new Promise(r => setTimeout(r, 1000));
      }
      json(504, { error: `${tier.label} did not become healthy within 60s. Process pid=${proc.pid} still running; check logs.` });
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

  return false;
};
