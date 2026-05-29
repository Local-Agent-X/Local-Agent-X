// xAI Grok TTS — POST https://api.x.ai/v1/tts with the SuperGrok / X
// Premium+ OAuth bearer (or XAI_API_KEY fallback). Opt-in only:
// bridgeVoicePreference="xai" picks it; the local sidecar chain stays
// the default because local is faster (the three-tier voice was
// tuned for 0.9-3s warm path on a mid-range GPU).
//
// xAI's TTS endpoint is NOT OpenAI-compat. It takes a flat payload with
// voice_id + language and returns raw audio bytes (default mp3).

import { createLogger } from "../logger.js";
import { resolveCredential } from "../auth/resolve.js";

const logger = createLogger("voice.xai");

const DEFAULT_VOICE = "eve";
const DEFAULT_LANGUAGE = "en";

async function getCredential(): Promise<string | null> {
  const resolved = await resolveCredential("xai");
  return resolved?.credential || null;
}

export async function synthesizeXai(text: string, voice?: string): Promise<Buffer | null> {
  const apiKey = await getCredential();
  if (!apiKey) {
    logger.info("[synthesize] xAI: no credential (OAuth or XAI_API_KEY) — skipping");
    return null;
  }
  const voiceId = voice && voice.trim() ? voice.trim() : DEFAULT_VOICE;
  try {
    const res = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, voice_id: voiceId, language: DEFAULT_LANGUAGE }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn(`[synthesize] xAI TTS failed (${res.status}): ${body.slice(0, 200)}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    logger.warn(`[synthesize] xAI TTS error: ${(e as Error).message}`);
    return null;
  }
}
