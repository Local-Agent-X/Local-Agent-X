// Mistral Voxtral cloud STT adapter.
//
// Endpoint: POST https://api.mistral.ai/v1/audio/transcriptions
// Model:   voxtral-mini-latest (also: voxtral-small-latest)
// Auth:    Bearer MISTRAL_API_KEY
// Body:    multipart/form-data with `file=<wav>`, `model=<id>`,
//          optional `language`. Response shape: { text: string }.
//
// NOTE on stability: this adapter follows Mistral's documented Voxtral
// transcription endpoint. It has been observed in flux during the Voxtral
// rollout (rate-limit shape, response_format support). If a request shape
// drift is detected in production, treat this file as the migration point —
// don't paper over it in voice-session.

import { createLogger } from "../../logger.js";
import type { WhisperTranscriber, WhisperProvider } from "../whisper-stream.js";
import type { SttProviderConfig } from "./types.js";
import { pcmToWav } from "./wav-encoder.js";
import { isWhisperHallucination } from "./hallucination-filter.js";

const logger = createLogger("voice.stt.mistral");

const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_MODEL = "voxtral-mini-latest";
const DEFAULT_TIMEOUT_MS = 30_000;

export function createMistralTranscriber(cfg: SttProviderConfig = {}): WhisperTranscriber {
  const apiKey = cfg.apiKey ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MISTRAL_API_KEY is not set. Export it or pass cfg.apiKey to use the Mistral Voxtral STT provider.",
    );
  }

  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = cfg.model ?? DEFAULT_MODEL;
  const language = cfg.language ?? "en";
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}/audio/transcriptions`;

  let closed = false;
  let jobChain: Promise<void> = Promise.resolve();

  async function postOnce(pcm: Int16Array): Promise<string> {
    const wav = pcmToWav(pcm, 16000);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("model", model);
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
        throw new Error(`Mistral Voxtral STT ${res.status}: ${body.slice(0, 300)}`);
      }
      // Voxtral returns { text } at minimum; some builds also return
      // segments/language. We only need the joined text.
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

    get runtime(): { provider: WhisperProvider; fellBack: boolean } {
      return { provider: "cpu", fellBack: false };
    },
  };
}
