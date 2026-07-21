# Known issues — code-level bugs

Code defects (not doc bugs) surfaced by the docs-sync audit. Each is verified
against source. Remove an entry when its fix lands.

> Tracked here because the repo has no GitHub issue tooling configured locally
> (`gh` not installed). Convert to GitHub issues if/when preferred.

Six of the original seven were fixed on 2026-06-04 (stale comments in
self-edit-sandbox / ari-kernel / catalog / resampler; dangling arikernel
`LICENSE.md` metadata; sovits torch pin — which turned out to be a real
cu126/2.5.1 wheel mismatch, now unified to 2.6.0; and `LAX_FORCE_CPU_TORCH` is
now honored by the sovits installers). The structural item below remains.

## Lite voice sidecar is GPU-only; the CI "cpu" voice artifacts are mislabeled or CPU-unverified

- **Where:** [python/voice/requirements.txt](../python/voice/requirements.txt),
  [python/chatterbox/install.ps1:58](../python/chatterbox/install.ps1#L58),
  [.github/workflows/build-voice-artifacts.yml:96](../.github/workflows/build-voice-artifacts.yml#L96)
  (`build-lite`, `build-chatterbox`)
- **What:** The lite sidecar is GPU-only by design — `voice/requirements.txt`
  hard-pins `onnxruntime-gpu==1.20.1` + `nvidia-cublas-cu12` / `nvidia-cudnn-cu12`
  ("voice **GPU** sidecar … all assume CUDA 12.x"). chatterbox installs
  `chatterbox-streaming --extra-index-url …/cu128` but *does* honor
  `LAX_FORCE_CPU_TORCH` (`chatterbox/install.ps1:58`) — under it the installer
  keeps chatterbox's pinned CPU torch and skips the CUDA override, so the
  chatterbox `-cpu-` artifact is at least torch-CPU (full CPU operation is
  still unverified). The **lite** installer has no CPU code path:
  `voice/requirements.txt` hard-pins `onnxruntime-gpu` and the `nvidia-*` CUDA
  wheels regardless of `LAX_FORCE_CPU_TORCH`. The CI jobs run on GPU-less
  `windows-latest` and upload `lite-venv-cpu-py311.zip` /
  `chatterbox-venv-cpu-py311.zip` — but the lite venv contains CUDA-only
  packages. On a CPU-only end-user box `onnxruntime-gpu` finds no CUDA
  providers (the lite installer's own verify step even prints CUDA
  troubleshooting). So the lite "cpu" artifact can't run TTS on a CUDA-less
  box.
- **Why not fixed here:** CPU-ifying a GPU sidecar (swap `onnxruntime-gpu` →
  `onnxruntime`, drop the `nvidia-*` wheels, use the CPU torch index) is a
  dependency-graph change that must be validated by actually building and
  running the venv on a CPU box — it can't be verified by inspection, and a
  wrong change risks breaking the working GPU path while still not producing a
  functioning CPU venv.
- **Fix (needs maintainer decision + CI verification):** either build genuine
  CPU variants of the lite/chatterbox sidecars, or stop building/labeling the
  lite artifact as `-cpu-` (the lite installer still ignores
  `LAX_FORCE_CPU_TORCH`).
- **Type:** build/CI structural gap · **Severity:** medium

## WebRTC voice transport is implemented but unverified on physical hardware

- **Where:** [src/voice/audio-ws.ts](../src/voice/audio-ws.ts),
  [src/voice/voice-peer.ts](../src/voice/voice-peer.ts),
  [src/voice/opus-codec.ts](../src/voice/opus-codec.ts) (and the
  `WebRtcVoiceClient` in the agentxos-mobile repo); see
  [ADR 0002](adr/0002-webrtc-voice-transport-via-werift.md).
- **What:** The WebRTC voice path (werift peer + `@evan/opus` WASM codec,
  signaled over `/ws/voice` via `rtc_offer`/`rtc_answer`/`rtc_ice`, desktop as
  offerer) is fully implemented and default-on behind the phone's transport
  flag, but it has NOT been validated on a physical device: ICE connectivity
  over the broker voice bridge (`channel=voice`, broker-minted STUN/TURN — the
  tailnet transport was removed in `1a681e5e`, so the broker is the only
  phone↔desktop path), real `getUserMedia` AEC quality, and `react-native-webrtc`
  native media all need an EAS rebuild + a phone to confirm. The legacy raw-PCM
  voice path remains the verified default fallback (selected when `hello`
  omits `transport` or sets `"pcm"`), and its removal is deferred until this
  on-device verification passes.
- **Type:** unverified-on-hardware · **Severity:** medium
