// Public surface for the OpenAI Realtime bridge mode.
//
// Activation (wired in voice-session.ts dispatcher, not here):
//   LAX_VOICE_MODE=realtime           → use this mode instead of the standard pipeline
//   OPENAI_REALTIME_KEY | OPENAI_API_KEY → upstream auth
//   LAX_REALTIME_VOICE                → alloy (default) | echo | fable | onyx | nova | shimmer
//   LAX_REALTIME_MODEL                → override the default realtime model
//   LAX_REALTIME_INSTRUCTIONS         → optional system-style prompt

import type { VoiceSession, VoiceSessionContext } from "../audio-ws.js";
import { createRealtimeSession, type RealtimeSessionOptions } from "./realtime-session.js";
import { DEFAULT_MODEL, DEFAULT_VOICE, VALID_VOICES } from "./openai-realtime-client.js";

export { DEFAULT_MODEL, DEFAULT_VOICE, VALID_VOICES } from "./openai-realtime-client.js";
export { createRealtimeSession } from "./realtime-session.js";
export type { RealtimeSessionOptions } from "./realtime-session.js";

function resolveApiKey(): string | undefined {
  const k = process.env.OPENAI_REALTIME_KEY || process.env.OPENAI_API_KEY;
  return k && k.trim() ? k.trim() : undefined;
}

function resolveVoice(): string {
  const v = (process.env.LAX_REALTIME_VOICE || "").trim().toLowerCase();
  return v && VALID_VOICES.has(v) ? v : DEFAULT_VOICE;
}

function resolveModel(): string {
  const m = (process.env.LAX_REALTIME_MODEL || "").trim();
  return m || DEFAULT_MODEL;
}

export interface RealtimeReadiness {
  ready: boolean;
  reason?: string;
}

/** Probe used by the dispatcher to decide whether realtime mode is usable.
 *  Currently only checks for an API key — connectivity to OpenAI is
 *  validated lazily on first session. */
export function realtimeReadiness(): RealtimeReadiness {
  const key = resolveApiKey();
  if (!key) {
    return {
      ready: false,
      reason: "OPENAI_REALTIME_KEY or OPENAI_API_KEY must be set for realtime mode",
    };
  }
  return { ready: true };
}

/** Factory matching the createGpuSession / createVoiceSessionFactory shape
 *  so the dispatcher in voice-session.ts can swap it in. Reads its config
 *  from env at call time (per-session) so flipping LAX_REALTIME_VOICE
 *  takes effect without a restart. */
export function createRealtimeSessionFromEnv(ctx: VoiceSessionContext): VoiceSession {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    // Defensive: the dispatcher should have called realtimeReadiness()
    // first, but if it didn't, fail with a useful event rather than
    // throwing at the WebSocket layer.
    ctx.sendEvent({
      type: "voice_error",
      message: "realtime mode requires OPENAI_REALTIME_KEY or OPENAI_API_KEY",
    });
    return { onMicFrame() {}, close() {} };
  }
  const opts: RealtimeSessionOptions = {
    apiKey,
    model: resolveModel(),
    voice: resolveVoice(),
  };
  const instr = process.env.LAX_REALTIME_INSTRUCTIONS;
  if (instr && instr.trim()) opts.instructions = instr;
  return createRealtimeSession(opts, ctx);
}
