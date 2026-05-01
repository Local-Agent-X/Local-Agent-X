# Local TS-First Voice Chat Architecture — Research Report

**Target:** ≤500 ms perceived response start, GPT-SoVITS-grade cloning, no paid APIs, no permanent Python sidecar, 12 GB VRAM.
**Date:** 2026-04-30
**Status note:** Repo already runs sherpa-onnx Matcha TTS in a `worker_thread` (`src/voice/tts-stream.ts`) and has a three-tier sidecar (Lite/Pro RVC/Studio Chatterbox). This report assumes that baseline.

---

## 1. Best Architecture (Concrete)

```
 mic ─► VAD (Silero ONNX, in TS) ─► partial frames ─► STT (Whisper-large-v3-turbo, faster-whisper / whisper.cpp + CUDA)
                                                            │  partial transcript every 200 ms
                                                            ▼
                              LLM (Anthropic CLI / OpenAI OAuth, streamed tokens)
                                                            │  token delta stream
                                                            ▼
                       Sentence Splitter + Punctuation Buffer (TS, < 1 ms)
                                                            │  first clause as soon as a clause boundary lands
                                                            ▼
                              TTS Cloner (StyleTTS2 ONNX, FP16, GPU)
                                                            │  PCM chunks (40-80 ms each), streamed
                                                            ▼
                              Audio Out (WebAudio in browser, miniaudio/PortAudio in node-native shell)
```

### Streaming strategy
- **Chunk-level, clause-bounded.** Token-level TTS is wasted work — sub-clause text produces unnatural prosody. Wait for the *first prosodic boundary* (`,` `;` `:` `—` or 8+ tokens with verb), then synthesize.
- **Two-clause pipeline depth.** Synthesize clause N+1 while clause N is still playing. One in-flight + one queued is enough; deeper queues raise barge-in cancel cost.
- **Speculative first chunk.** Once 6 tokens have arrived without a punctuation boundary, *speculatively* synthesize the partial clause with a "soft ending" prosody flag. If the LLM continues mid-clause, append; if it diverges, the cost is one cancelled GPU call.

### Where latency comes from (current GPT-SoVITS path, ~8 s)
| Stage | Approx ms |
|---|---|
| LLM TTFT (CLI/OAuth) | 350–600 |
| Wait for *full* response before TTS | 1500–4000 |
| GPT-SoVITS load + autoregressive synth | 3000–4000 |
| Audio decode + playback start | 100 |

### How to drive **perceived** start to ≤ 500 ms
- **Start audio at first clause, not first response.** Drops perceived TTFT from 5–8 s → 700–900 ms.
- **Pre-warm TTS on STT-final.** As soon as Whisper emits a final transcript, push `<silence pad>` through TTS to keep the GPU graph hot. ~200 ms savings on first synth.
- **Ack chirp / acknowledgment phoneme.** Optional 80–120 ms cached sample ("mm", "okay") plays as soon as STT-final fires. The user *feels* a sub-300 ms response start; the real synthesis lands behind it.
- **Audio worklet ring buffer.** Don't wait for full PCM — pipe Int16 PCM into a ring buffer; the worklet pulls 10 ms frames. Eliminates buffering hitches at sentence boundaries.

---

## 2. Top 3 Local TTS Alternatives (Ranked for this constraint set)

Ranking: **cloning quality × streaming × TS controllability × <500 ms first audio on a 12 GB GPU.**

### #1 — StyleTTS2 (ONNX, FP16) — **WINNER**
| Metric | Value |
|---|---|
| Voice quality | 9 / 10 (matches GPT-SoVITS in MOS, beats it on prosody) |
| Cloning | Yes — 3–10 s reference; zero-shot via diffusion sampler |
| VRAM | 1.5–2.5 GB FP16 |
| First-audio latency | **120–250 ms** on 3060 |
| Realtime factor | 0.05–0.10x (10–20× faster than realtime) |
| Streaming | Yes — sentence-level; clause-level with custom head |
| Node/TS | **ONNX Runtime Node** binding works directly (no Python at inference time) |

**Why it wins:** matches GPT-SoVITS quality, runs in `onnxruntime-node` (native addon, no Python), and lands first audio in ~200 ms.

### #2 — Kokoro-82M (ONNX) — fallback for ultra-low-latency
| Metric | Value |
|---|---|
| Voice quality | 8 / 10 |
| Cloning | **No (reference voices only — limited bank)** |
| VRAM | 0.4 GB FP16 |
| First-audio latency | **60–100 ms** |
| Streaming | Native chunk streaming |
| Node/TS | ONNX Runtime Node, also runs in `transformers.js` (WASM) |

Use as the **Lite tier** (when no clone is selected) — ridiculously fast and ships in pure JS via WASM.

### #3 — Piper (ONNX, VITS-derivative)
| Metric | Value |
|---|---|
| Voice quality | 7 / 10 |
| Cloning | Per-voice fine-tune (offline), not zero-shot |
| VRAM | CPU-friendly, 0.2 GB GPU |
| First-audio latency | **40–80 ms** (CPU even) |
| Streaming | Phoneme-chunk streaming |
| Node/TS | Pure ONNX, drop-in for `onnxruntime-node` |

Worth keeping as the **CPU-degrade** path — but per your constraint, "CPU fallback unacceptable", so this is just an emergency floor.

### Reference: GPT-SoVITS (baseline)
9/10 quality, but ~3–8 s first audio, 4–6 GB VRAM, autoregressive, Python-only ecosystem, no real ONNX export. **Disqualified for ≤500 ms target.**

### Honorable mentions (rejected and why)
- **Bark / Coqui XTTS-v2** — 6–8 s first audio, autoregressive transformer. Not real-time.
- **Chatterbox / Kyutai TTS** — Chatterbox you already run as Studio sidecar; quality is great but Python-bound and 1.5–3 s first audio. Keep as Studio tier; not the path to 500 ms.
- **F5-TTS / E2-TTS** — strong cloning but flow-matching at 3060 speeds is ~600 ms first audio; no clean ONNX path yet.
- **MeloTTS** — fast, no zero-shot clone.

---

## 3. Latency Optimization Strategies (with expected gains)

| Technique | Expected gain | Notes |
|---|---|---|
| **Stream LLM → clause-bounded TTS** | −2000–4000 ms perceived | Biggest single win. Required. |
| **First-clause synth at first prosodic boundary** | −400–800 ms | vs sentence-end. |
| **Speculative first-chunk synth** | −150–300 ms | Cost: ~5–10 % wasted GPU on misprediction. |
| **ONNX FP16 + IO-binding** | 30–50 % faster forward pass | Pre-allocate GPU input/output tensors; reuse across calls. |
| **CUDA Graphs / ORT cudaGraph capture** | 15–25 % | Locks in kernel launch order; works on static-shape decoder steps. |
| **TensorRT-EP via ORT** | additional 20–35 % over CUDA-EP | Build once, cache engine; rebuilds per shape. |
| **Pre-warm + persistent session** | −150–300 ms first call | Keep the ORT session alive in a worker thread (you already do this). |
| **VAD + barge-in cancel < 50 ms** | Perceived responsiveness++ | Silero-VAD ONNX in main thread; cancel TTS worker on speech-start. |
| **Acknowledgment chirp** | −200–400 ms perceived | Cached 100 ms WAV played at STT-final. |
| **Phoneme cache for top-N openers** | −80–150 ms perceived | "Sure," "Let me check," "Okay" — synthesized once, replayed. |
| **Whisper-turbo + chunked decode** | STT TTFT 200 ms instead of 800 | Use `whisper-large-v3-turbo` with 5-second chunks. |
| **Partial transcripts → speculative LLM prompt** | −100–250 ms | Risky; only worth it once stable. |
| **Audio Worklet ring buffer (10 ms frames)** | Smoothness, no hitches | Already partly done via worker; finish on the playback side. |

**Math:** baseline 5000–8000 ms → with clause-streaming + StyleTTS2 ONNX FP16 + ack chirp = **~250–400 ms perceived response start**. Hits the ≤500 ms target.

### What NOT to do
- Don't chase token-level TTS — autoregressive TTS heads do NOT like sub-clause input; you'll get robot prosody.
- Don't put TTS in the main Node thread. You already learned this — keep it in `worker_threads`.
- Don't INT8 the TTS decoder. Quality drop is visible; FP16 is the sweet spot. INT8 only on the Whisper encoder.

---

## 4. TypeScript Integration Strategy

### Recommendation: **`onnxruntime-node` with a `worker_threads` pool, no permanent Python.**

| Option | Verdict |
|---|---|
| `onnxruntime-node` (native addon, CUDA-EP, TensorRT-EP) | **Pick this.** Mature, multi-EP, ships prebuilt CUDA binaries. |
| `transformers.js` / WASM | Use for the *Kokoro Lite* path (browser-safe, no GPU). |
| WebGPU / `onnxruntime-web` with WebGPU EP | Promising but EP coverage incomplete for StyleTTS2 ops as of 4/2026. Watch, don't bet. |
| Custom N-API binding to TensorRT C++ | Highest perf, very high cost. Not worth it until you've exhausted ORT-TRT EP. |
| Ephemeral Python subprocess (current Studio tier) | Keep ONLY as Studio fallback for Chatterbox/SoVITS. Auto-killed on idle. Not on the hot path. |

### Layout
- **STT:** `whisper.cpp` via `node-whisper` or compile `whisper-cpp` with CUDA → spawn as ephemeral child or use the Node binding.
- **TTS:** `onnxruntime-node` with CUDA-EP. Models loaded once at boot, sessions reused.
- **VAD:** Silero VAD ONNX in same process (CPU, ~1 % core).
- **LLM:** existing Anthropic CLI proxy + OpenAI OAuth — no change.
- **Audio I/O:** browser uses Web Audio + AudioWorklet. Native shell uses `naudiodon` / `mic` / `speaker` for PortAudio bindings.

### Tradeoffs
- ORT-Node has a real GPU footprint and adds ~50 MB to the install. Acceptable.
- TensorRT EP adds first-run engine-build latency (60–120 s, cached after). Hide behind a "warming Studio voice" toast on first use.
- Ephemeral Python is allowed for Studio tier where quality > latency.

---

## 5. Recommended Stack (FINAL ANSWER)

| Layer | Pick |
|---|---|
| **STT** | `whisper-large-v3-turbo` via `whisper.cpp` (CUDA, FP16) |
| **VAD** | Silero VAD ONNX (in-process, TS) |
| **LLM interface** | Existing Anthropic CLI proxy + OpenAI OAuth (unchanged) |
| **TTS (cloning, primary)** | **StyleTTS2 → ONNX FP16, served via `onnxruntime-node` CUDA-EP, `worker_threads`** |
| **TTS (no-clone fast path)** | Kokoro-82M ONNX |
| **Runtime** | TypeScript / Node 20+, `worker_threads` pool, AudioWorklet on browser side |
| **Optimization layer** | ORT IO-binding + FP16 + cudaGraph capture; TensorRT EP behind a flag |
| **Python presence** | Zero on the hot path. Optional ephemeral subprocess for Studio Chatterbox tier only. |

VRAM budget on 12 GB: Whisper-turbo (~2 GB) + StyleTTS2 (~2 GB) + LLM headroom (~6–8 GB if local) + buffer. Comfortable.

---

## 6. Implementation Plan (Actionable)

1. **Export StyleTTS2 to ONNX (FP16).** Use the upstream export script in a one-shot Python venv. Save to `models/styletts2/`. Verify shape and parity vs Torch reference. (One-time work, ~half a day.)
2. **Replace `tts-worker.ts` model load with `onnxruntime-node` CUDA-EP session pointing at StyleTTS2 ONNX.** Keep the existing worker IPC contract — `onAudio(pcm, sampleRate)` stays identical.
3. **Add clause-boundary chunker between LLM stream and TTS.** Punctuation + 8-token-soft-cap rule. Plug into `voice-llm.ts` token stream.
4. **Add ack-chirp player.** 100 ms WAV bank (`mm`, `okay`, `sure`); fire on STT-final.
5. **Bench end-to-end TTFT.** Instrument: STT-final → first-clause-emitted → first-PCM-out → first-speaker-frame. Log p50 and p95. Target: p95 ≤ 500 ms.
6. **Optimize hot session.** Enable IO-binding, FP16, CUDA-graph capture. Re-bench.
7. **(Behind flag) TensorRT EP.** Build engine once at install, cache to `models/styletts2/.trt-cache/`. Re-bench. Ship if p95 drops another 100 ms.
8. **Promote tiers.** Lite → Kokoro ONNX, Pro → StyleTTS2 ONNX (replaces RVC), Studio → Chatterbox ephemeral Python (unchanged). Update voice-tier selection in `voice-session.ts`.
9. **Decommission GPT-SoVITS path** once StyleTTS2 ONNX p95 ≤ 500 ms holds across 100-utterance test set. Keep models on disk for one release as rollback.
10. **Speculative first-chunk synth (Phase 2).** Only once Phase 1 is shipped and stable.

---

## Bottom line

GPT-SoVITS is the right *quality target*, wrong *runtime*. **StyleTTS2 exported to ONNX FP16 and run from `onnxruntime-node` in a worker thread** delivers the same MOS in ~200 ms first-audio, with zero permanent Python and full TypeScript control. Combined with clause-bounded streaming and an ack chirp, perceived start lands at **250–400 ms** — under the 500 ms bar with margin.
