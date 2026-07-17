import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export interface VoiceTier {
  id: string;
  label: string;
  port: number;
  venvDir: string;        // installation marker
  installerPath: string;  // install.ps1 on Windows / install.sh on Mac/Linux — "" if no installer
  startCmd: () => { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  healthUrl: string;
  description: string;
  diskFootprint: string;
  // "native" tiers run in-process (no Python sidecar). install/start/stop
  // routes are inert for them; status comes from a readiness probe instead
  // of /healthz. Defaults to "sidecar" for back-compat with existing tiers.
  kind?: "sidecar" | "native";
  // Lowercase substrings that ALL must appear in a process's command line to
  // identify it as this tier's sidecar. Used by the orphan reaper to find
  // hung sidecars by signature when they've stopped listening (so pidOnPort
  // misses them). Omit for native tiers.
  procMatch?: string[];
  // Import-name dirs that must be present in the venv's site-packages for the
  // tier to count as installed (see detection.isInstalled). Guards the
  // "pip install failed but the venv exists" state, which the interpreter
  // check alone reports as installed. Keep each list a subset of what that
  // tier's installer verifies. Omit to fall back to the interpreter check.
  installMarkers?: string[];
}

export const REPO_ROOT = resolve(process.cwd());
export const HOME = homedir();
export const IS_WIN = platform() === "win32";
export const PYTHON_EXE = IS_WIN ? "Scripts/python.exe" : "bin/python";
export const INSTALLER_EXT = IS_WIN ? "install.ps1" : "install.sh";

export const TIERS: VoiceTier[] = [
  {
    id: "lite",
    label: "Lite (GPU sidecar)",
    port: Number(process.env.LAX_VOICE_PORT) || 7008,
    venvDir: join(HOME, ".lax", "python-voice", "venv"),
    installerPath: join(REPO_ROOT, "python", "voice", INSTALLER_EXT),
    startCmd: () => ({
      command: join(HOME, ".lax", "python-voice", "venv", PYTHON_EXE),
      args: [join(REPO_ROOT, "python", "voice", "server.py")],
      env: { ...process.env, LAX_VOICE_PORT: String(Number(process.env.LAX_VOICE_PORT) || 7008) },
    }),
    healthUrl: `http://127.0.0.1:${process.env.LAX_VOICE_PORT || "7008"}/healthz`,
    description: "faster-whisper STT + Kokoro TTS + Silero VAD. Built-in voices, GPU-accelerated streaming.",
    diskFootprint: "~3–4 GB",
    procMatch: ["python-voice", "server.py"],
    // numpy is the module whose absence crashed the sidecar at boot
    // (_server/cuda_bootstrap.py imports it at module scope); the other two
    // are the tier's reason for existing. Subset of python/voice/_smoke.py.
    installMarkers: ["numpy", "faster_whisper", "kokoro_onnx"],
  },
  {
    id: "studio",
    label: "Studio (Chatterbox)",
    port: Number(process.env.LAX_CHATTERBOX_PORT) || 7010,
    venvDir: join(HOME, ".lax", "python-chatterbox", "venv"),
    installerPath: join(REPO_ROOT, "python", "chatterbox", INSTALLER_EXT),
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
    procMatch: ["python-chatterbox", "server:app"],
    // Both are installed unconditionally by python/chatterbox/install.ps1
    // (torch via chatterbox-streaming, fastapi explicitly) and torch is the
    // module that installer smoke-checks.
    installMarkers: ["torch", "fastapi"],
  },
  {
    id: "studio-vox",
    label: "Studio-Vox (VoxCPM)",
    port: Number(process.env.LAX_VOXCPM_PORT) || 7013,
    venvDir: join(HOME, ".lax", "python-voxcpm", "venv"),
    installerPath: join(REPO_ROOT, "python", "voxcpm", INSTALLER_EXT),
    startCmd: () => ({
      command: join(HOME, ".lax", "python-voxcpm", "venv", PYTHON_EXE),
      args: [join(REPO_ROOT, "python", "voxcpm", "server.py")],
      cwd: join(REPO_ROOT, "python", "voxcpm"),
      env: { ...process.env },
    }),
    healthUrl: `http://127.0.0.1:${process.env.LAX_VOXCPM_PORT || "7013"}/healthz`,
    description: "VoxCPM2 — primary voice-clone engine (won the 2026-07 listening bake-off). Zero-shot cloning from a 10-30s clip, 48kHz output.",
    diskFootprint: "~7 GB (model auto-downloads on first use)",
    procMatch: ["python-voxcpm", "server.py"],
    // Both are installed unconditionally by python/voxcpm/install.ps1 and
    // are what that installer's verify pass refuses to succeed without.
    installMarkers: ["voxcpm", "fastapi"],
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

export const tierById = (id: string) => TIERS.find(t => t.id === id);

// What users type in the bridge /voice command → tier ids in TIERS above.
// Lives next to the registry so the two can't drift apart silently (the map
// once pointed at ids like "studio-sovits" that no tier ever had, making
// /voice start a guaranteed "Unknown tier" error).
export const VOICE_COMMAND_TIER_MAP: Record<string, string> = {
  lite: "lite",
  studio: "studio-vox",
  vox: "studio-vox",
  voxcpm: "studio-vox",
  chatterbox: "studio",
};
