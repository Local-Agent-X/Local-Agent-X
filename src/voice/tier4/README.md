# Tier 4 — Native ONNX TTS (Kokoro)

In-process TTS for Local Agent X. No Python sidecar, no port, no `/healthz`.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Shared types + `TIER4_DEFAULTS`. |
| `voice-clone-loader.ts` | HF cache pin to `~/.lax/models/tts/kokoro-onnx/`; ref-WAV loader for cloning. |
| `kokoro-engine.ts` | `KokoroTTS.from_pretrained` wrapper, `synth()` one-shot per sentence. |
| `streaming-tts.ts` | Adapter to SAX's `StreamingTTS` contract (queue + drain + cancel). |
| `chatterbox-clone-stub.ts` | Scaffolding for voice cloning (NOT IMPLEMENTED). |
| `tier4-factory.ts` | `createTier4()` variant dispatcher; `tier4Readiness()` probe. |
| `index.ts` | Public barrel. |

## Wiring (already done)

- `src/voice/voice-session.ts` — `LAX_VOICE_TIER=4` dispatches to `createTier4()` instead of WASM Sherpa Matcha.
- `src/routes/bridges/voice-setup.ts` — `kind: "native"` tier reports readiness via `tier4Readiness()` + model cache probe.
- `public/js/settings.js` — `renderVoiceTierCard()` skips install/start/stop buttons for native tiers.

## How to enable

```
LAX_VOICE_GPU=0 LAX_VOICE_TIER=4 npm run dev
```

Tier 4 only activates in CPU-mode (`LAX_VOICE_GPU=0`). With `LAX_VOICE_GPU=1` (default) the GPU sidecar wins.

## Smoke test

```
npx tsx scripts/test-tier4-smoke.mjs --device cpu --write tier4.wav
```

Default voice `am_michael`. Override with `--voice af_bella` etc. — see kokoro-js docs for the 28 baked voices.

## What's NOT here

- Voice cloning. `chatterbox-clone-stub.ts` validates the reference WAV but does not run inference. See `docs/voice-tier4-status.md` for the path forward.
- Live voice switching mid-session. Voice fixes at session start.
- CUDA EP. Stock onnxruntime-node only ships CPU + DirectML; CUDA needs a custom build.
