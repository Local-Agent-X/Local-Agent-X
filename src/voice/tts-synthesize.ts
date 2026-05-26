// Unified TTS entry point. Bridges (Telegram/WhatsApp) can ONLY use
// server-side TTS — there's no browser to run window.speechSynthesis on
// the user's behalf.
//
// Probe order is user-configurable via config.bridgeVoicePreference. The
// preferred engine is tried first; the others remain in the chain as a
// fallback so an unhealthy preference doesn't silence the bridge. After
// the sidecar tier, falls through to local-binary engines (Kokoro/Piper),
// then Windows SAPI as the always-available floor.

import { createLogger } from "../logger.js";
import { detectCapabilities } from "./capabilities.js";
import { trySidecarSynth, tryLiteSynth } from "./tts-sidecars.js";
import { synthesizeKokoro, synthesizePiper, synthesizeWinSapi } from "./tts-local.js";
import { synthesizeXai } from "./tts-xai.js";

const logger = createLogger("voice");

type EngineId = "sovits" | "chatterbox" | "lite" | "xai";

export async function synthesize(
  text: string,
  voice?: string,
  speed?: number,
): Promise<Buffer> {
  const cbPort = Number(process.env.LAX_CHATTERBOX_PORT) || 7010;
  const svPort = Number(process.env.LAX_SOVITS_PORT) || 7012;
  const litePort = Number(process.env.LAX_VOICE_PORT) || 7008;

  const ENGINE: Record<EngineId, () => Promise<Buffer | null>> = {
    sovits:     () => trySidecarSynth(svPort, "sovits", text),
    chatterbox: () => trySidecarSynth(cbPort, "chatterbox", text),
    lite:       () => tryLiteSynth(litePort, text, voice, speed),
    xai:        () => synthesizeXai(text, voice),
  };

  // Default chain (auto) is sovits→chatterbox→lite — clones first, then built-in.
  // xAI is opt-in only (bridgeVoicePreference="xai"); not in the auto chain
  // because remote round-trips lose to local sidecars on the dev setup.
  let preference: "auto" | EngineId = "auto";
  try {
    const { getRuntimeConfig } = await import("../config.js");
    preference = getRuntimeConfig().bridgeVoicePreference ?? "auto";
  } catch {}

  const baseOrder: EngineId[] = ["sovits", "chatterbox", "lite"];
  const order: EngineId[] = preference === "auto"
    ? baseOrder
    : [preference, ...baseOrder.filter(e => e !== preference)];

  for (const id of order) {
    const buf = await ENGINE[id]();
    if (buf) return buf;
  }

  const caps = await detectCapabilities();
  logger.info(`[synthesize] sidecars unavailable, caps.tts=${caps.tts}`);
  if (caps.tts === "kokoro") return synthesizeKokoro(text, voice || "am_onyx", speed || 0.95);
  if (caps.tts === "piper") return synthesizePiper(text);

  if (process.platform === "win32") {
    const sapi = synthesizeWinSapi(text);
    if (sapi.length > 0) return sapi;
  }
  logger.warn(`[synthesize] no TTS engine reachable — returning empty buffer (caller will fall back to text)`);
  return Buffer.alloc(0);
}
