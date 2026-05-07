// Groq cloud STT adapter.
//
// Endpoint: POST https://api.groq.com/openai/v1/audio/transcriptions
// Model:   whisper-large-v3-turbo (fast, ~5% WER, free-tier friendly)
// Auth:    Bearer GROQ_API_KEY
// Body:    multipart/form-data with `file=<wav>`, `model=<id>`,
//          `response_format=json`, optional `language`.
//
// We POST a 16kHz mono WAV produced by pcmToWav(); Groq accepts wav/mp3/m4a
// up to 25MB. A typical utterance (3-5s) is ~100KB.

import { createLogger } from "../../logger.js";
import type { WhisperTranscriber, WhisperProvider } from "../whisper-stream.js";
import type { SttProviderConfig } from "./types.js";
import { pcmToWav } from "./wav-encoder.js";
import { isWhisperHallucination } from "./hallucination-filter.js";

const logger = createLogger("voice.stt.groq");

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "whisper-large-v3-turbo";
const DEFAULT_TIMEOUT_MS = 30_000;

export function createGroqTranscriber(cfg: SttProviderConfig = {}): WhisperTranscriber {
  const apiKey = cfg.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Export it or pass cfg.apiKey to use the Groq STT provider.",
    );
  }

  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = cfg.model ?? DEFAULT_MODEL;
  const language = cfg.language ?? "en";
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}/audio/transcriptions`;

  let closed = false;
  // Serialize jobs to match local whisper-stream behavior — keeps ordering
  // deterministic for downstream consumers that assume FIFO transcripts.
  let jobChain: Promise<void> = Promise.resolve();

  async function postOnce(pcm: Int16Array): Promise<string> {
    const wav = pcmToWav(pcm, 16000);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("model", model);
    form.append("response_format", "json");
    if (language) form.append("language", language);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: ctl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Groq STT ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { text?: string };
      const text = (json.text ?? "").trim();
      if (isWhisperHallucination(text)) return "";
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    transcribe(pcm: Int16Array): Promise<string> {
      if (closed) return Promise.resolve("");
      const job = jobChain.then(async () => {
        if (closed) return "";
        try {
          return await postOnce(pcm);
        } catch (e) {
          logger.warn("transcribe failed", (e as Error).message);
          return "";
        }
      });
      jobChain = job.then(() => undefined, () => undefined);
      return job;
    },

    close() {
      if (closed) return;
      closed = true;
    },

    // Cloud providers don't have an ONNX execution provider concept.
    // Surface "cpu"/fellBack=false so the runtime field stays well-typed
    // for downstream telemetry that already reads it.
    get runtime(): { provider: WhisperProvider; fellBack: boolean } {
      return { provider: "cpu", fellBack: false };
    },
  };
}
