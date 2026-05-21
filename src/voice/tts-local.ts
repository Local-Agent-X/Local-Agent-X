// Local-binary TTS engines, in quality order:
//   - synthesizeKokoro: Kokoro ONNX via Python. ChatGPT-quality.
//   - synthesizePiper: Piper. Good quality, instant, ONNX-direct.
//   - synthesizeWinSapi: Windows SAPI (System.Speech.Synthesis). Built into
//     every Windows box — robotic 2003-era voice but always-available
//     floor, beats silent text-only fallback.
//
// Each returns Buffer.alloc(0) on failure so the caller's "is there any
// audio" check (`if (buf.length > 0) return buf`) keeps the routing chain
// flat.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createLogger } from "../logger.js";
import { KOKORO_MODEL, KOKORO_VOICES, PIPER_EXE, PIPER_VOICE, TMP_DIR, tmpPath } from "./paths.js";
import { cleanForTTS } from "./text-cleaning.js";

const logger = createLogger("voice");

export function synthesizeKokoro(
  text: string,
  voice: string = "am_onyx",
  speed: number = 1.15,
): Buffer {
  const clean = cleanForTTS(text);
  if (!clean) return Buffer.alloc(0);

  const outPath = tmpPath("wav");

  try {
    // Run Kokoro via temp Python script (cmd.exe mangles inline Python).
    const pyScriptPath = tmpPath("py");
    const pyScript = `
import sys, wave, numpy as np
from kokoro_onnx import Kokoro
k = Kokoro('${KOKORO_MODEL.replace(/\\/g, "/")}', '${KOKORO_VOICES.replace(/\\/g, "/")}')
samples, sr = k.create(sys.argv[1], voice=sys.argv[2], speed=float(sys.argv[3]), lang='en-us')
with wave.open(sys.argv[4], 'wb') as f:
    f.setnchannels(1)
    f.setsampwidth(2)
    f.setframerate(sr)
    f.writeframes((samples * 32767).astype(np.int16).tobytes())
`.trim();

    writeFileSync(pyScriptPath, pyScript, "utf-8");
    try {
      execFileSync("python", [pyScriptPath, clean, voice, String(speed), outPath.replace(/\\/g, "/")], {
        timeout: 30_000,
        stdio: "ignore",
      });
    } finally {
      try { unlinkSync(pyScriptPath); } catch {}
    }

    if (existsSync(outPath)) return readFileSync(outPath);
    return Buffer.alloc(0);
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
}

export function synthesizePiper(text: string): Buffer {
  const clean = cleanForTTS(text);
  if (!clean) return Buffer.alloc(0);

  const outPath = tmpPath("wav");

  try {
    execFileSync(PIPER_EXE, [
      "--model", PIPER_VOICE,
      "--output_file", outPath,
    ], {
      input: clean,
      timeout: 15_000,
      stdio: ["pipe", "ignore", "ignore"],
    });

    if (existsSync(outPath)) return readFileSync(outPath);
    return Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
}

// Synchronous PowerShell call — produces a 16kHz/mono/PCM WAV via
// System.Speech.Synthesis. Quality is low (robotic, classic Windows
// narrator-tier) but it works zero-install on every Windows box, which
// makes it the right always-available floor for bridge voice replies
// when no real engine is up. Skipped on non-Windows.
export function synthesizeWinSapi(text: string): Buffer {
  const clean = cleanForTTS(text);
  if (!clean) return Buffer.alloc(0);
  const outPath = tmpPath("wav");
  const escaped = clean.replace(/'/g, "''"); // PowerShell literal: '' inside ' '
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile('${outPath.replace(/\\/g, "\\\\")}')
$s.Speak('${escaped}')
$s.Dispose()
`.trim();
  const scriptPath = join(TMP_DIR, `sapi_${randomBytes(6).toString("hex")}.ps1`);
  try {
    writeFileSync(scriptPath, ps, "utf-8");
    try {
      execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        timeout: 30_000, stdio: "ignore", windowsHide: true,
      });
    } finally { try { unlinkSync(scriptPath); } catch {} }
    if (existsSync(outPath)) {
      const buf = readFileSync(outPath);
      logger.info(`[synthesize] win-sapi bytes=${buf.length}`);
      return buf;
    }
    return Buffer.alloc(0);
  } catch (e) {
    logger.warn(`[synthesize] win-sapi failed: ${(e as Error).message}`);
    return Buffer.alloc(0);
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
}
