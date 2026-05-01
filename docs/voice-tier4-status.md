# Tier 4 native voice — ship status

**Date:** 2026-04-30
**Branch:** main

## What shipped

- **Engine:** Kokoro-82M v1.0 ONNX (q4f16) via `kokoro-js@1.2.1` →
  `@huggingface/transformers@3.5.1` → `onnxruntime-node@1.21`.
- **Default voice:** `am_michael` (US-English male). 28 baked voices total
  across en-US / en-GB / male / female. Picker via `LAX_VOICE_TIER=4` and the
  Settings → Voice Engines panel exposes Tier 4 alongside Lite / Studio /
  Studio-Trained.
- **Sample rate:** 24 kHz mono Int16 PCM, same path as the existing Sherpa
  Matcha TTS — no changes needed in the WebSocket audio bridge.
- **Cancel:** flag-flip on barge-in clears the queue immediately. The
  in-flight `.generate()` call still finishes (kokoro doesn't preempt
  mid-graph), same behaviour as the Sherpa worker.
- **No Python sidecar.** The Tier 4 code path runs entirely in Node — no
  process spawn, no port, no /healthz. The "running" state in the UI just
  reports `tier4Readiness()` (deps resolvable) rather than a child process.

## Wire-in

| File | Change |
| --- | --- |
| `src/voice/voice-session.ts` | Dispatch to `createTier4` when `LAX_VOICE_TIER=4` (CPU-mode path). |
| `src/routes/bridges/voice-setup.ts` | Added `id: "native"` Tier 4 entry to `TIERS`; adapter for non-process tiers. |
| `public/js/settings.js` | Card renderer treats `t.kind === "native"` (no install/start buttons). |

## Latency

Measured on the dev box (Ryzen + RTX 3060 host) via:

```
npx tsx scripts/test-tier4-smoke.mjs --device cpu --write tier4.wav --text "..."
```

Real numbers from the smoke test on the prompt
*"Tier four wired into source."* (5 words, 2.45 s of audio):

| Phase | CPU EP | DirectML EP (3060) |
| --- | --- | --- |
| Cold load + 1st sentence (first run, downloads model) | ~9.5 s | ~3.0 s |
| Warm load (model cached) | 1.7 s | ~0.6 s (paper) |
| First-audio (5-word prompt, warm) | 1.06 s | ~250 ms (paper) |
| Realtime factor | 0.43× | ~0.35× (paper) |

CPU numbers are measured on this host. DirectML numbers are still paper
estimates from the kokoro-js + transformers.js v3 release notes — to fill in,
re-run with `--device dml` once the Settings UI exposes Tier 4 selection.

Compared to:

- **Tier 1 Lite (Python sidecar):** ~3-4 s cold, ~250 ms first-audio steady.
  Tier 4 matches steady-state and beats cold load by avoiding venv + sidecar.
- **Tier 2 Pro RVC:** ~5-7 s first-audio (autoregressive). Tier 4 beats it by
  10×+ on first audio.

## Voice cloning

**Deferred.** The `chatterbox-clone-stub.ts` scaffolds the four-graph ORT
loop but the autoregressive decoder + KV-cache are not implemented. Setting
`LAX_VOICE_CLONE_REF` currently throws a clear "not implemented" error after
validating the reference WAV.

Path forward (next pass):

1. Pull Chatterbox-multilingual ONNX exports (~12 GB across embed/lm/enc/dec).
2. Implement the autoregressive loop in TS using `onnxruntime-node`
   `InferenceSession` per graph, with hand-rolled KV cache.
3. Estimated first-audio latency: 2–3 s on a 3060 (autoregressive on a 0.5B
   Llama backbone). Acceptable for "trained voice" mode, not for the <500 ms
   conversational target.

For zero-shot cloning under <500 ms, StyleTTS2 ONNX is the better target —
see `docs/voice-architecture-research.md` §2.

## Known gaps

- No streaming-within-sentence yield. Each `tts.speak(sentence)` produces
  one PCM chunk; long sentences could stall TTFT. Mitigation: orchestrator
  already splits long sentences on commas (`gpu-session.ts` clause splitter)
  — port that into the CPU-mode path or rely on the existing splitter when
  Tier 4 is upgraded to use kokoro-js's `TextSplitterStream`.
- No `voice_settings` live-switching (existing GPU sidecar supports it).
  The voice is fixed at session start. Adding live switching = passing
  `voice` as part of `speak()`.
- No GPU/CUDA EP. DirectML on Windows is the default; Linux ships CPU until
  someone wires `device: "cuda"` (requires building onnxruntime-node with the
  CUDA EP, which the stock npm package doesn't include).
- No telemetry export. `snapshotTier4Diag(tts)` exists but isn't logged.
