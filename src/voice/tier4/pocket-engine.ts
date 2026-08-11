// Pocket TTS (Kyutai) engine wrapper — no-Python, voice-cloning, streaming.
//
// Pocket is a C++/ONNX binary (not in-process JS like Kokoro/Kitten): a
// resident HTTP server prewarmed once per voice session. We expose the same
// Tier4Engine shape { synth, close, sampleRate, modelId, runtime } so the
// shared streaming adapter (streaming-tts.ts) drives it through the one code
// path — see tier4-factory.ts. synth() POSTs one sentence to the local server
// and returns whole 24 kHz audio; the streaming wrapper already gives
// sentence-level play-as-you-go. (Intra-sentence /tts streaming is a follow-up.)
//
// Runtime install: $LAX/pocket-tts/{pocket-tts, libonnxruntime.dylib, models/,
// voices/}. Missing binary → createPocketEngine throws so the caller can
// degrade to another engine.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { createLogger } from "../../logger.js";
import type { Tier4Config, Tier4Device, Tier4Dtype } from "./types.js";
import { TIER4_SAMPLE_RATE } from "./types.js";
import { guardPocketAudio } from "./pocket-guard.js";

const logger = createLogger("voice.tier4.pocket");

export const POCKET_MODEL_ID = "pocket-tts";
const POCKET_DEFAULT_VOICE = "am_michael.wav";
const HEALTH_TIMEOUT_MS = 20_000;

type RawAudio = { audio: Float32Array; sampling_rate: number };

export interface PocketEngine {
  synth(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudio>;
  close(): Promise<void>;
  readonly sampleRate: number;
  readonly voice: string;
  readonly modelId: string;
  readonly runtime: { device: Tier4Device; dtype: Tier4Dtype; fellBack: boolean };
}

export interface PocketEngineInit {
  config: Tier4Config;
  onLoad?: (ms: number) => void;
}

/** The Pocket install dir, or "" — exported so readiness checks can reuse it. */
export function pocketInstallDir(): string {
  return join(getLaxDir(), "pocket-tts");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function waitHealthy(port: number, deadline: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const j = await r.json().catch(() => null) as { status?: string } | null;
        if (j && j.status === "ok") return;
      }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("pocket-tts server did not become healthy in time");
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function createPocketEngine(init: PocketEngineInit): Promise<PocketEngine> {
  const dir = pocketInstallDir();
  const bin = join(dir, "pocket-tts");
  if (!existsSync(bin)) {
    throw new Error(`Pocket TTS not installed (${bin} missing) — install the runtime under ${dir}`);
  }
  const voice = init.config.voice && init.config.voice.endsWith(".wav")
    ? init.config.voice
    : POCKET_DEFAULT_VOICE;

  const t0 = Date.now();
  const port = await freePort();
  // Use the binary's default eos settings (the bench baseline). Post-hoc
  // trimming (pocket-guard) is the safety net for the residual over-generation.
  const proc: ChildProcess = spawn(bin, [
    "--server", "--port", String(port),
    "--models-dir", "models", "--voices-dir", "voices",
  ], { cwd: dir, stdio: "ignore" });

  let procExited = false;
  proc.on("exit", (code) => { procExited = true; if (code) logger.warn(`[pocket] server exited code=${code}`); });
  proc.on("error", (e) => { procExited = true; logger.warn(`[pocket] spawn error: ${(e as Error).message}`); });

  const kill = () => { try { if (!procExited) proc.kill("SIGKILL"); } catch { /* already gone */ } };

  try {
    await waitHealthy(port, Date.now() + HEALTH_TIMEOUT_MS);
  } catch (e) {
    kill();
    throw new Error(`pocket-tts failed to start: ${(e as Error).message}`);
  }
  init.onLoad?.(Date.now() - t0);
  logger.info(`[pocket] server ready on :${port} (voice=${voice})`);

  let closed = false;
  // Single-worker server — serialize synth calls so concurrent turns don't
  // back-pressure each other (bench finding).
  let chain: Promise<unknown> = Promise.resolve();

  async function synthOne(text: string, v: string, speed: number): Promise<RawAudio> {
    if (closed || procExited) throw new Error("pocket engine closed");
    const r = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tts-1", input: text, voice: v, response_format: "pcm", speed }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`pocket synth failed (${r.status})`);
    const buf = await r.arrayBuffer();
    // f32le PCM @ 24 kHz. Copy off the ArrayBuffer (subarray view is fine here).
    const raw = new Float32Array(buf, 0, Math.floor(buf.byteLength / 4));
    const audio = guardPocketAudio(text, raw, TIER4_SAMPLE_RATE,
      (i) => logger.info(`[pocket] over-gen trimmed ${i.fromSec.toFixed(1)}s→${i.toSec.toFixed(1)}s "${text.slice(0, 32)}"`));
    return { audio, sampling_rate: TIER4_SAMPLE_RATE };
  }

  return {
    synth(text, opts) {
      const v = opts?.voice && opts.voice.endsWith(".wav") ? opts.voice : voice;
      const speed = opts?.speed ?? init.config.speed ?? 1;
      const run = chain.then(() => synthOne(text, v, speed));
      // Keep the chain alive regardless of this call's outcome.
      chain = run.catch(() => undefined);
      return run;
    },
    async close() { closed = true; kill(); },
    get sampleRate() { return TIER4_SAMPLE_RATE; },
    get voice() { return voice; },
    get modelId() { return POCKET_MODEL_ID; },
    // Pocket runs INT8 ONNX; report the enum's 8-bit-quant value (q8).
    get runtime() { return { device: "cpu" as Tier4Device, dtype: "q8" as Tier4Dtype, fellBack: false }; },
  };
}
