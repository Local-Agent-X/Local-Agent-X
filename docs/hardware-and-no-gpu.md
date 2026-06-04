# Hardware requirements and no-GPU setup

LAX is a local-first agent — most of it runs fine on CPU. A few subsystems lean on GPU acceleration; without a GPU they either fall back to slower CPU paths or need to be routed through a cloud provider. This doc covers what changes when you don't have a GPU.

## Quick verdict

| You have… | What works | What needs config |
|---|---|---|
| **NVIDIA GPU (CUDA)** | Everything | Nothing |
| **Apple Silicon** | Everything | Nothing — Metal is auto-detected |
| **AMD GPU on Linux (ROCm)** | Everything | Set `HSA_OVERRIDE_GFX_VERSION` if ROCm doesn't auto-detect |
| **AMD GPU on Windows** | CPU-only paths | Ollama falls back to CPU; treat as no-GPU |
| **Integrated graphics (Intel UHD, AMD Radeon APU)** | CPU-only paths | Treat as no-GPU |
| **No GPU** | Cloud-routed paths | See "Cloud routing" below |

## What needs a GPU (or runs dramatically slower without)

### Memory embeddings — Ollama (`nomic-embed-text` / `mxbai-embed-large`)
- **GPU**: ~50–200 ms per call.
- **CPU**: ~12–25 seconds per call. Memory-live indexing of a single chat session can queue 10+ embed calls and back-pressure the chat pipeline behind it.
- **Symptom of CPU-bound Ollama**: chat hangs on first turn after restart while the embedding queue drains; logs show repeated `[memory] Embedding total timeout exceeded (60s)`.
- **Fix**: switch to cloud embeddings (see "Cloud routing"), or set `"embeddingProvider": "local"` in `~/.lax/settings.json` to use the bundled hash embedder (free, no Ollama — lower-quality recall but no CPU stalls).

### Voice STT — local Whisper (`local-whisper` provider)
- **GPU**: real-time transcription, ~300 ms after speech-end.
- **CPU**: 3–10 seconds for a short utterance, 30+ seconds for long ones.
- **Fix**: pick a non-local STT tier (Groq, OpenAI, Mistral) — see [voice picker](#voice-tier-recommendations).

### Voice TTS — Kokoro in-process (Tier 4 ONNX; env-only via `LAX_VOICE_TIER4_PROVIDER=kokoro`)
- **GPU**: ~1.2 s first-audio.
- **CPU**: 2–4 s first-audio plus ongoing latency. Usable but laggy for back-and-forth voice chat.

### Voice STT streaming — Zipformer (Sherpa-ONNX)
- **GPU**: imperceptible — adds <50 ms partial latency.
- **CPU**: works fine, partials lag ~200–400 ms. Acceptable.

### Local chat LLMs (Ollama / llama.cpp)
- **GPU (24+ GB VRAM)**: 32B models at usable speed.
- **GPU (8–12 GB)**: 7B–13B at usable speed.
- **CPU**: 7B models are 2–10 tokens/sec — unusably slow for agent use. Don't bother; use a cloud chat provider.

### Voice cloning — Studio tiers (Chatterbox / GPT-SoVITS)
- **GPU only.** These are Python sidecars that won't start without CUDA. Switch to a non-Studio voice tier on GPU-less machines.

### Image / video generation
- **GPU only.** Falls back to error if no compatible device.

## Cloud routing — what to flip when you have no GPU

These are the configuration changes that take a no-GPU machine from "barely works" to "feels native":

### 1. Embeddings → OpenAI

Edit `~/.lax/settings.json`:
```json
{
  "embeddingProvider": "openai",
  "embeddingModel": "text-embedding-3-small"
}
```

Cost: ~$0.02 per million tokens (a few cents/day for typical use). Vector format is the same as Ollama's nomic/mxbai once normalized — past content stays searchable. Restart the server after editing.

Alternative: set `"embeddingProvider": "local"` in `~/.lax/settings.json`. Sessions are still indexed in real-time, but with the bundled hash-based embedder instead of Ollama — free and no CPU stalls, at the cost of lower-quality semantic recall. Restart the server after editing.

### 2. Voice tier → Browser, Edge cloud, or OpenAI Realtime

Open the Media tab and pick one of:

- **Browser** — free, no install, works in any Chromium browser. Uses Web Speech API client-side for both STT and TTS. Robotic but instant. Recommended if you just want voice to work.
- **Edge cloud** — Microsoft's edge-tts (no API key) for ~22 neural voices, paired with bundled local Whisper STT by default (no key). Ships with the app — no manual install. Optionally swap STT to cloud Groq/OpenAI/Mistral via the dropdown (needs the matching API key) for lower latency.
- **OpenAI Realtime** — full-duplex, lowest latency, ~$0.06/min. Pay-per-minute. Needs `OPENAI_API_KEY` (or `OPENAI_REALTIME_KEY`).

Don't pick "Studio local" without a GPU — its Python sidecars (Kokoro + faster-whisper, optional SoVITS/Chatterbox) are slow or won't start without CUDA.

### 3. Chat LLM → cloud provider (default)

Cloud models (Anthropic, OpenAI, xAI, Gemini) all run server-side. Pick from the model dropdown in the chat bar. No GPU involved on your end.

If you want a local chat LLM and have an Ollama install with a small enough model (e.g. `llama3.2:3b`), it'll work — just expect slow tool-calling loops. Most users on no-GPU machines stay on cloud chat.

## Hardware tiers we test against

- **Reference dev box**: NVIDIA RTX 3060/4060+ (8–12 GB VRAM). All features GPU-accelerated.
- **Low-end laptop**: Integrated graphics, 16+ GB RAM. Cloud-routed via the steps above. Memory embeddings on cloud, voice on Browser/Edge tier, chat on Anthropic/OpenAI.
- **Apple Silicon (M-series)**: Metal auto-accelerates Ollama and ONNX. Treat as GPU.

## Common no-GPU symptoms and what they mean

| Symptom | Cause | Fix |
|---|---|---|
| First chat after restart hangs 30–60s | Tool-RAG embedding all 170+ tools through CPU Ollama | Wait once; subsequent restarts hit the warm cache. Or switch embeddings to OpenAI. |
| Chat stalls indefinitely | Memory-live queued embed backlog blocking prepareAgentRequest | Restart server (clears queue). Long-term: switch `embeddingProvider` to `openai` (cloud) or `local` (bundled hash embedder). |
| Voice chat mic captures audio but agent never responds | `voiceSttProvider: local-whisper` on a CPU-only box | Switch voice tier to Browser, Edge cloud, or OpenAI Realtime. |
| `[ari] Kernel initialized` then voice session emits `voice_error` | Tier 4 trying to load Kokoro on CPU and timing out | Pick a non-local voice tier. |
| `nvidia-smi: command not found` in logs | No NVIDIA GPU or driver missing | Confirm with `Get-CimInstance Win32_VideoController` (Windows). If integrated/AMD, treat as no-GPU. |

## Verifying your setup

Check what Ollama is actually using:
```bash
curl -s http://127.0.0.1:11434/api/ps
```
The `size_vram` field tells you VRAM bytes in use. `0` means CPU-only.

Time a single embedding to know your cost-per-call:
```bash
time curl -s -X POST http://127.0.0.1:11434/api/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text:latest","prompt":"test"}'
```
- Under 500 ms: GPU working.
- 1–5 s: CPU on a fast box.
- 10–25 s: CPU on a slow box. Switch to cloud embeddings.
