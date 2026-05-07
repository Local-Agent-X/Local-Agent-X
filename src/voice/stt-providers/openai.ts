// OpenAI Whisper API adapter.
//
// Endpoint: POST https://api.openai.com/v1/audio/transcriptions
// Model:   whisper-1 (the only first-party Whisper model OpenAI exposes;
//          gpt-4o-transcribe lives at the same endpoint and is a drop-in
//          model swap via cfg.model).
// Auth:    Bearer <key>. We try VOICE_TOOLS_OPENAI_KEY first so users with
//          a separate OpenRouter setup on OPENAI_API_KEY don't accidentally
//          ship audio to the wrong gateway.
// Body:    multipart/form-data, identical shape to Groq.

import { createLogger } from "../../logger.js";
import type { WhisperTranscriber, WhisperProvider } from "../whisper-stream.js";
import type { SttProviderConfig } from "./types.js";
import { pcmToWav } from "./wav-encoder.js";
import { isWhisperHallucination } from "./hallucination-filter.js";

const logger = createLogger("voice.stt.openai");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "whisper-1";
const DEFAULT_TIMEOUT_MS = 30_000;

export function createOpenAITranscriber(cfg: SttProviderConfig = {}): WhisperTranscriber {
  const apiKey =
    cfg.apiKey
    ?? process.env.VOICE_TOOLS_OPENAI_KEY
    ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Neither VOICE_TOOLS_OPENAI_KEY nor OPENAI_API_KEY is set. "
      + "Export one (VOICE_TOOLS_OPENAI_KEY preferred) to use the OpenAI STT provider.",
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
        throw new Error(`OpenAI STT ${res.status}: ${body.slice(0, 300)}`);
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

    get runtime(): { provider: WhisperProvider; fellBack: boolean } {
      return { provider: "cpu", fellBack: false };
    },
  };
}
