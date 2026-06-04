# Tier 4 — Multi-provider TTS (Kokoro default; chatterbox-clone, edge-tts)

Pluggable TTS registry for Local Agent X. The default provider (Kokoro) is
in-process native ONNX — no Python sidecar, no port, no `/healthz`. `edge-tts`
is a cloud (WebSocket) option registered alongside it.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Shared types + `TIER4_DEFAULTS`. |
| `env.ts` | `LAX_VOICE_TIER4_*` env parsing/validation. |
| `registry.ts` | String-keyed TTS provider registry (`registerTtsProvider`). |
| `voice-clone-loader.ts` | HF cache pin to `~/.lax/models/tts/kokoro-onnx/`; ref-WAV loader for cloning. |
| `kokoro-engine.ts` | `KokoroTTS.from_pretrained` wrapper, `synth()` one-shot per sentence. |
| `kokoro-voices.ts` | Kokoro voice-ID allowlist + metadata (`KOKORO_VOICES`). |
| `streaming-tts.ts` | Adapter to the `StreamingTTS` contract (queue + drain + cancel). |
| `chatterbox-clone-stub.ts` | Scaffolding for voice cloning (NOT IMPLEMENTED). |
| `edge-tts-adapter.ts` | Cloud Edge Read-Aloud provider (msedge-tts + mpg123-decoder). |
| `edge-voices.ts` | Curated Edge voice list. |
| `tier4-factory.ts` | `createTier4()` + registry dispatch across providers; `tier4Readiness()` probe. |
| `index.ts` | Public barrel. |

## Wiring (already done)

- `src/voice/voice-session/model-init.ts` — when the resolved engine is `"tier4"` (`LAX_VOICE_TIER=4` or the `voiceEngine` setting), dispatches to `createTier4()` instead of the CPU-fallback Sherpa+Matcha path.
- `src/routes/bridges/voice-setup/detection.ts` — `kind: "native"` tier reports readiness via `tier4Readiness()` + `tier4ModelDownloaded()` cache probe.
- `public/js/settings-voice-engines.js` — `renderVoiceTierCard()` skips install/start/stop buttons for native tiers.

## How to enable

```
LAX_VOICE_TIER=4 npm run dev
```

`LAX_VOICE_TIER=4` selects Tier 4 regardless of GPU mode — it's checked before and independently of `LAX_VOICE_GPU`. The primary selector is the `voiceEngine` setting in `~/.lax/settings.json` (`engine="tier4"`); `LAX_VOICE_TIER=4` is the env override.

## Smoke test

```
npx tsx scripts/test-tier4-smoke.mjs --device cpu --write tier4.wav
```

Default voice `am_michael`. Override with `--voice af_bella` etc. — see `kokoro-voices.ts` (`KOKORO_VOICES`) for the 54 baked voices.

## What's NOT here

- Voice cloning. `chatterbox-clone-stub.ts` validates the reference WAV but does not run inference (see its in-file TODO for the path forward).
- Live voice switching mid-session. Voice fixes at session start.
- CUDA EP. Stock onnxruntime-node only ships CPU + DirectML; CUDA needs a custom build.
