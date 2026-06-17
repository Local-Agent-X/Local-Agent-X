# ADR 0002 — WebRTC voice transport via werift (extend, not fork)

Status: Accepted — 2026-06-17 · implementation behind a default-on flag on the
phone, unverified on hardware.

## Context

The streaming voice path shipped as raw Int16 PCM over a `/ws/voice` WebSocket
(see `src/voice/audio-ws.ts`). It works, but it has no acoustic echo
cancellation: on a phone using the loudspeaker, the mic re-captures the agent's
own TTS, so the agent hears itself and barge-in (interrupting mid-reply) is
unreliable. We need cross-device AEC and reliable barge-in on every phone, not
just on the handful where the OS happens to route audio through a comms session.

Two cheaper options were rejected:

- **Half-duplex (mute the mic while TTS plays).** Eliminates the echo by never
  listening during playback — but it structurally *cannot* interrupt mid-reply.
  The whole point of barge-in is to talk over the agent; a half-duplex path
  can't hear you until it has stopped talking. Non-starter.
- **OS-level AEC on the existing PCM path (react-native-audio-api).** The mobile
  audio library has no way to put the session into the platform's
  communications/voice mode on Android — there is no comms-session routing hook
  — so the platform AEC never engages for our capture graph. AEC quality would
  be device-lottery at best, absent at worst.

The reliable way to get AEC + duplex barge-in on every device is the browser/RN
**WebRTC** stack: `getUserMedia` runs the platform's tuned echo canceller, and a
duplex peer connection lets the mic stay live while TTS plays.

## Decision

Add a WebRTC voice transport, and build it by **extending the existing werift
WebRTC stack** already used by `src/screen-stream/peer.ts` — not by adding a
native addon (e.g. `@roamhq/wrtc`). This preserves the repo's no-native-build
rationale and its one-source-of-truth rule (one WebRTC library, not two).

For the audio codec we use the **`@evan/opus` WASM** Opus↔PCM codec
(`src/voice/opus-codec.ts`) plus a resampler, again avoiding a native ABI
dependency. The bidirectional peer lives in `src/voice/voice-peer.ts` +
`src/voice/voice-rtp-audio.ts` (inbound Opus mic → 16kHz PCM → STT; outbound TTS
PCM → 48kHz → Opus → paced RTP, with inband-FEC / DTX / 24kbps).

Architecture / seams:

- **Signaling shares `/ws/voice`.** No second socket. A `hello` carrying
  `transport:"webrtc"` switches that session's audio onto the VoicePeer; the
  socket then carries SDP/ICE (`rtc_offer` / `rtc_answer` / `rtc_ice`) alongside
  the existing JSON control events.
- **Desktop is the OFFERER.** On the webrtc `hello` the server creates the offer
  and trickles ICE; the phone (a `WebRtcVoiceClient` built on
  `react-native-webrtc`, in the separate agentxos-mobile repo) answers, with
  bounded reconnect.
- **Two seams in `audio-ws.ts`.** (1) The `hello` handler branches on
  `transport`, defaulting to the unchanged PCM path. (2) The peer factory is
  injected and dynamic-imported lazily, so the boot graph never pulls werift in
  unless WebRTC is actually used. On a terminal peer `"failed"` state the server
  emits `{type:"error",message:"webrtc_failed"}` and tears down idempotently.

## Consequences

- The legacy PCM path is **kept as a flag-selectable fallback** and is unchanged
  when `transport` is absent or `"pcm"`. It remains the verified default.
- The remaining gate is **on-device verification + an EAS rebuild**: ICE
  connectivity over Tailscale, real AEC quality, and `react-native-webrtc`
  native media have NOT been validated on a physical phone. Until that passes,
  the PCM path stays.
- **Removal of the PCM path is deferred** until on-device verification of the
  WebRTC path succeeds. Two audio transports coexist in the meantime; that
  duplication is intentional and time-boxed, not a missed consolidation.
- One WebRTC library and one audio codec dependency style (WASM, no native
  build) across screen-stream and voice — the no-native-build invariant holds.
