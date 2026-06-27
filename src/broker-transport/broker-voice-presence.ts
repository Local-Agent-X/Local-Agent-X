// BrokerVoicePresence — keeps THIS desktop present in the SEPARATE voice rendezvous
// (channel=voice) so its paired phone can start a voice session on demand. It reuses the
// generic BrokerPresence supervisor (reconnect-on-close) with a voice dialer factory and
// the "voice" channel, exactly as the screen presence does for the main room. A second,
// idle WebSocket while voice is unused — the phone DIALING the voice room is the
// "user tapped the mic" trigger; until then no werift peer is built (deferred to
// peer-present inside BrokerVoiceDialer).
//
// Kept in its own file so the voice deps (VoicePeer/werift, the session factory) stay out
// of the screen presence module's import graph.

import {
  BrokerPresence,
  DEFAULT_RECONNECT_MS,
  type BrokerPresenceConfig,
  type BrokerPresenceDeps,
} from "./broker-presence.js";
import { openBrokerSocket } from "./ws-socket-adapter.js";
import { BrokerVoiceDialer } from "./broker-voice-dialer.js";
import { getVoiceSessionFactory } from "../voice/audio-ws.js";

/** Production deps: a real ws-backed voice dialer reusing the registered session factory. */
export function defaultVoicePresenceDeps(): BrokerPresenceDeps {
  return {
    createDialer: (connectUrl, token, onClosed) => {
      const socket = openBrokerSocket(connectUrl, token);
      // The SAME factory /ws/voice uses — broker voice runs the identical STT→LLM→TTS brain.
      return new BrokerVoiceDialer({ socket, sessionFactory: getVoiceSessionFactory(), onClosed });
    },
    reconnectMs: DEFAULT_RECONNECT_MS,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
    now: () => Date.now(),
    random: () => Math.random(),
  };
}

/** Construct + start the desktop's voice presence (channel=voice). Returns it for shutdown. */
export function startBrokerVoicePresence(config: Omit<BrokerPresenceConfig, "channel">): BrokerPresence {
  const presence = new BrokerPresence({ ...config, channel: "voice" }, defaultVoicePresenceDeps());
  presence.start();
  return presence;
}
