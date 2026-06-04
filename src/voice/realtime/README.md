# OpenAI Realtime Bridge

Full-duplex voice mode that proxies the browser's microphone audio to
OpenAI's Realtime API and streams the model's voice back. Bypasses the
local STT + LLM + TTS pipeline entirely; intended for meeting-bot and
phone-call use cases where end-to-end latency and natural turn-taking
matter more than running locally.

## Activation

```sh
LAX_VOICE_MODE=realtime
OPENAI_REALTIME_KEY=sk-...        # falls back to OPENAI_API_KEY
LAX_REALTIME_VOICE=alloy          # alloy | echo | fable | onyx | nova | shimmer
LAX_REALTIME_MODEL=...            # optional, defaults to gpt-4o-realtime-preview-2024-12-17
LAX_REALTIME_INSTRUCTIONS=...     # optional system-style prompt
```

The dispatcher in `voice-session/index.ts` checks `realtimeReadiness()` and,
when ready, builds a session via `createRealtimeSessionFromEnv(ctx, overrides)`
— same shape as `createGpuSession`. The optional `overrides` (`{ voice, model }`)
let settings.json win over the `LAX_REALTIME_*` env vars per session, so a UI
change applies on the next session without a restart; any field absent from
overrides falls back to env.

If `realtimeReadiness()` reports not-ready (no `OPENAI_REALTIME_KEY` /
`OPENAI_API_KEY`), the dispatcher logs a `warn` (`voiceMode=realtime but
<reason> — falling back to normal pipeline`) and continues into the standard
local STT + LLM + TTS pipeline rather than failing the session.

## Audio path

```
browser mic 16kHz Int16  →  upsample16to24  →  base64 PCM16 24kHz  →  OpenAI Realtime
browser playback         ←  passthrough     ←  base64 PCM16 24kHz  ←  OpenAI Realtime
```

`resampler.ts` is a dependency-free linear interpolator. Quality is fine
for speech at the 3:2 ratio; a polyphase filter would be marginally
cleaner.

## Turn-taking and barge-in

`turn_detection: { type: "server_vad" }` is configured on the session, so
the OpenAI side handles endpointing and barge-in cancellation. When the
upstream fires `input_audio_buffer.speech_started` we forward
`vad_speech_start` to the browser, send `response.cancel` upstream, and
emit `tts_interrupt` so the browser flushes its playback ring buffer —
the same event flow `voice-session.ts` already uses.

## Cost

OpenAI Realtime is roughly **\$5-15/hr per active session** at current
pricing (audio in + audio out tokens). Confirm against
<https://openai.com/api/pricing/> before opening this to many users.
A session start log line includes the cost note for visibility.

## Function calling

Not in scope for v1. The session is configured with no tools.

```ts
// TODO(v2): wire tools via session.update tools field
```

## Manual smoke test

1. Set the env vars above.
2. Start the server (`npm run dev`) and open the voice page.
3. Watch logs for `[realtime-session] <id>: starting OpenAI Realtime bridge`.
4. Talk; you should hear the model voice within ~300-600ms.
5. Talk over the model mid-reply — the response should cancel on the
   server and your browser playback should flush.

## Files

- `openai-realtime-client.ts` — WebSocket client wrapping the Realtime API.
- `resampler.ts` — Int16 linear resampler, 16↔24kHz, plus base64 helpers.
- `realtime-session.ts` — orchestrator that bridges a browser session to the client.
- `index.ts` — public barrel: `createRealtimeSessionFromEnv`, `realtimeReadiness`.
