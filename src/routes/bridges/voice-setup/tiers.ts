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
    installerPath: join(REPO_ROOT, "python", "sovits", INSTALLER_EXT),
    startCmd: () => ({
      command: join(HOME, ".lax", "sovits", "venv", PYTHON_EXE),
      args: [join(REPO_ROOT, "python", "sovits", "server.py")],
      cwd: join(REPO_ROOT, "python", "sovits"),
      env: { ...process.env },
    }),
    healthUrl: `http://127.0.0.1:${process.env.LAX_SOVITS_PORT || "7012"}/healthz`,
    description: "Fine-tuned voice cloning via GPT-SoVITS v2Pro. Train your own voices (~30–45 min on RTX 3060).",
    diskFootprint: "~5 GB (per trained voice: ~50–100 MB)",
    procMatch: ["sovits", "server.py"],
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
