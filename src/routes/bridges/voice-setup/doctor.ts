// Voice doctor — one-shot end-to-end diagnosis of the voice stack, in
// plain-English stages. Runs the REAL paths, not proxies for them: the STT
// stage synthesizes speech with Lite's own Kokoro and streams it back
// through the same /voice WebSocket the browser mic uses, so a pass here
// means the user's mic path actually works (VAD → transcribe → final).

import WebSocket from "ws";
import { createLogger } from "../../../logger.js";

const logger = createLogger("routes.bridges.voice-doctor");

export interface DoctorStage {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const LITE = () => `http://127.0.0.1:${process.env.LAX_VOICE_PORT || "7008"}`;
const VX = () => `http://127.0.0.1:${process.env.LAX_VOXCPM_PORT || "7013"}`;
const CB = () => `http://127.0.0.1:${process.env.LAX_CHATTERBOX_PORT || "7010"}`;

const STT_TEST_TEXT = "The quick brown fox jumps over the lazy dog.";

/** Minimal RIFF/WAVE PCM16 reader — enough for the sidecars' own output.
 *  Walks chunks to find fmt + data (some writers put LIST chunks first). */
export function parseWavPcm16(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let sampleRate = 0, channels = 1, bits = 16;
  let dataStart = -1, dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      dataStart = off + 8;
      dataLen = Math.min(size, buf.length - dataStart);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataStart < 0 || !sampleRate) throw new Error("no fmt/data chunk");
  if (bits !== 16) throw new Error(`expected PCM16, got ${bits}-bit`);
  const frames = Math.floor(dataLen / 2 / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // mono-mix multichannel; sidecar output is mono in practice
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += buf.readInt16LE(dataStart + (i * channels + c) * 2);
    out[i] = acc / channels / 32768;
  }
  return { samples: out, sampleRate };
}

/** Linear-interp resample — fidelity is irrelevant for a diagnostic clip. */
export function resampleLinear(samples: Float32Array, fromSr: number, toSr: number): Float32Array {
  if (fromSr === toSr) return samples;
  const n = Math.round(samples.length * toSr / fromSr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * (samples.length - 1) / Math.max(1, n - 1);
    const lo = Math.floor(x), hi = Math.min(samples.length - 1, lo + 1);
    out[i] = samples[lo] + (samples[hi] - samples[lo]) * (x - lo);
  }
  return out;
}

/** Enough shared words with the test sentence = the transcript is real. */
export function transcriptMatches(transcript: string, expected: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(w => w.length > 2));
  const got = words(transcript), want = words(expected);
  let hits = 0;
  for (const w of want) if (got.has(w)) hits++;
  return hits >= Math.ceil(want.size / 2);
}

async function probeJson(url: string, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json() as Record<string, unknown>;
  } catch { return null; }
}

/** Synthesize the test sentence with Lite's Kokoro, then stream it back
 *  through /voice as 16kHz mic frames and wait for the final transcript. */
async function sttRoundTrip(): Promise<{ ok: boolean; detail: string }> {
  const synth = await fetch(`${LITE()}/synth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: STT_TEST_TEXT }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!synth.ok) return { ok: false, detail: `Lite /synth returned ${synth.status}` };
  const wav = parseWavPcm16(Buffer.from(await synth.arrayBuffer()));
  const pcm = resampleLinear(wav.samples, wav.sampleRate, 16000);
  const withSilence = new Float32Array(pcm.length + 16000 * 2);
  withSilence.set(pcm, 8000); // lead-in + 2s tail so VAD opens and closes

  return await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.LAX_VOICE_PORT || "7008"}/voice`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, detail: "no transcript within 60s" }); }, 60_000);
    const finish = (r: { ok: boolean; detail: string }) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(r); };
    ws.on("error", e => finish({ ok: false, detail: `voice WS error: ${(e as Error).message}` }));
    ws.on("open", () => {
      ws.send(JSON.stringify({ cmd: "init" }));
      const chunk = 1600; // 100ms of 16k mono
      let i = 0;
      const pump = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || i >= withSilence.length) { clearInterval(pump); return; }
        const slice = withSilence.subarray(i, i + chunk);
        const int16 = new Int16Array(slice.length);
        for (let j = 0; j < slice.length; j++) int16[j] = Math.max(-32768, Math.min(32767, Math.round(slice[j] * 32767)));
        ws.send(JSON.stringify({ cmd: "audio", pcm: Buffer.from(int16.buffer).toString("base64") }));
        i += chunk;
      }, 20);
    });
    ws.on("message", data => {
      let msg: { type?: string; text?: string; message?: string };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "final") {
        const text = msg.text || "";
        finish(transcriptMatches(text, STT_TEST_TEXT)
          ? { ok: true, detail: `heard: "${text}"` }
          : { ok: false, detail: `transcript mismatch: "${text}"` });
      }
      if (msg.type === "error") finish({ ok: false, detail: msg.message || "sidecar error" });
    });
  });
}

async function cloneSynthCheck(base: string, engine: string): Promise<{ ok: boolean; detail: string }> {
  const list = await probeJson(`${base}/clones`);
  const clones = (list?.clones as Array<{ id?: string }> | undefined) ?? [];
  const first = clones.find(c => typeof c.id === "string");
  if (!first?.id) return { ok: true, detail: "no clones registered yet (nothing to test)" };
  try {
    const r = await fetch(`${base}/clones/${encodeURIComponent(first.id)}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Voice check." }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) return { ok: false, detail: `${engine} synth returned ${r.status}` };
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length < 1000 || bytes.toString("ascii", 0, 4) !== "RIFF") {
      return { ok: false, detail: `${engine} returned ${bytes.length} bytes of non-WAV data` };
    }
    return { ok: true, detail: `clone "${first.id}" synthesized ${bytes.length} bytes` };
  } catch (e) {
    return { ok: false, detail: `${engine} synth threw: ${(e as Error).message}` };
  }
}

export async function runVoiceDoctor(): Promise<{ ok: boolean; stages: DoctorStage[] }> {
  const stages: DoctorStage[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => {
    stages.push({ id, label, ok, detail });
    logger.info(`[doctor] ${id}: ${ok ? "OK" : "FAIL"} — ${detail}`);
  };

  const lite = await probeJson(`${LITE()}/healthz`);
  add("lite-health", "Lite sidecar (mic + built-in voice)", !!lite?.ok,
    lite ? `up, gpu=${lite.gpu || "?"}` : "not running — start it in Settings → Media");

  if (lite?.ok) {
    const stt = await sttRoundTrip();
    add("stt-roundtrip", "Microphone path (speech → text)", stt.ok, stt.detail);
  } else {
    add("stt-roundtrip", "Microphone path (speech → text)", false, "skipped — Lite is down");
  }

  const vx = await probeJson(`${VX()}/healthz`);
  add("voxcpm-health", "VoxCPM clone engine (primary)", !!vx?.ready,
    vx ? (vx.ready ? "ready" : "up but model not loaded yet") : "not running (clones fall back to Chatterbox/Kokoro)");
  if (vx?.ready) {
    const synth = await cloneSynthCheck(VX(), "VoxCPM");
    add("voxcpm-synth", "VoxCPM clone synthesis", synth.ok, synth.detail);
  }

  const cb = await probeJson(`${CB()}/healthz`);
  add("chatterbox-health", "Chatterbox clone engine (backup)", !!cb?.ready,
    cb ? (cb.ready ? "ready" : "up but model not loaded yet") : "not running (backup tier only)");

  // Backup tiers being down isn't a failing checkup — the stack works
  // without them. Overall verdict = the stages a working mic + voice needs.
  const critical = stages.filter(s => s.id === "lite-health" || s.id === "stt-roundtrip" || s.id === "voxcpm-synth");
  return { ok: critical.every(s => s.ok), stages };
}
