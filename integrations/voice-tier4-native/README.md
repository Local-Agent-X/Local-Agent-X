# Tier 4 — Native ONNX voice

Pure-Node voice synthesis. No Python sidecar, no FastAPI, no port 7008.
Lives outside `src/voice/` because the platform write-policy blocks edits to
`src/`; the orchestrator wire-in is a one-line dispatch (sketch below).

## What it ships

- **Kokoro-82M (q4f16)** as the fast path — 60+ baked voices, 24 kHz output.
- **Chatterbox-multilingual cloning** — scaffolded, not implemented.
  Reference-clip loader works; the autoregressive ORT inference loop is
  documented in `chatterbox-clone-stub.ts` for the next pass.

## Files

| File | Purpose |
| --- | --- |
| `types.ts` | Shared types + `TIER4_DEFAULTS` |
| `voice-clone-loader.ts` | HF cache pinning, reference WAV reader |
| `kokoro-engine.ts` | `kokoro-js` wrapper (push/iterator/cancel) |
| `streaming-tts.ts` | KokoroEngine → SAX `Tier4StreamingTTS` adapter |
| `tier4-factory.ts` | Public `createTier4(opts, cb)` entry |
| `chatterbox-clone-stub.ts` | Cloning path scaffolding only |
| `index.ts` | Barrel |

All files are under 200 LOC. No file touches `src/`.

## Runtime requirements

```bash
npm i kokoro-js@^1.2.1
# kokoro-js pulls @huggingface/transformers@^3.5.1 and phonemizer@^1.2.1
# transformers brings onnxruntime-node@^1.25 transitively — DirectML on Win64.
```

First run downloads ~80 MB of model weights to
`~/.lax/models/tts/kokoro-onnx/`. Subsequent runs are offline.

## Wire-in (3-line diff in `src/voice/voice-session.ts`)

```ts
// at top of file
import { createTier4, tier4Enabled, tier4VariantFromEnv } from
  "../../integrations/voice-tier4-native/index.js";

// where the existing tier dispatcher chooses sherpa / sidecar:
if (tier4Enabled()) {
  const tts = await createTier4(
    { variant: tier4VariantFromEnv(), voice: opts.voice, speed: opts.speed },
    { onAudio, onSentenceEnd, onIdle, onError },
  );
  return tts;
}
```

## Env flags

| Flag | Effect |
| --- | --- |
| `LAX_VOICE_TIER=4` | Route TTS through this integration |
| `LAX_VOICE_CLONE_REF=path/to/ref.wav` | Switch to chatterbox-clone variant (24 kHz mono, ≥5 s) |
| `LAX_VOICE_DEBUG=1` | Log model cache cold-start path |

## Latency targets (RTX 3060, q4f16, DirectML)

| Phase | Target | Notes |
| --- | --- | --- |
| Cold load | <2.5 s | First import; weights cached after |
| First audio chunk | <500 ms | Single sentence, warm session |
| Steady-state | ~0.4× realtime | Streaming yields per ~250 ms of audio |

These are paper estimates from the kokoro-js + transformers.js v3 release
notes; verify on the 3060 once the package is installed.

## Tests / verification (not yet wired)

The factory is testable headlessly: instantiate it with a no-op `onAudio`
and assert `firstAudioMs < 800` for a 5-word prompt. There is no test in
this commit — wiring requires `kokoro-js` in `package.json`, which is a
root-level edit best done by the supervisor.

## Why not modify `src/voice/` directly

`src/` writes are blocked by the platform safety layer. Following the
pattern set by `integrations/open-voice/`, the new code lives outside
`src/` and the supervisor or a follow-up PR adds the dispatcher line.
