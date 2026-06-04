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

## Lite + Chatterbox voice sidecars are GPU-only; their CI "cpu" artifacts are mislabeled

- **Where:** [python/voice/requirements.txt](../python/voice/requirements.txt),
  [python/chatterbox/install.ps1:44](../python/chatterbox/install.ps1#L44),
  [.github/workflows/build-voice-artifacts.yml:96](../.github/workflows/build-voice-artifacts.yml#L96)
  (`build-lite`, `build-chatterbox`)
- **What:** Both sidecars are GPU-only by design — `voice/requirements.txt`
  hard-pins `onnxruntime-gpu==1.20.1` + `nvidia-cublas-cu12` / `nvidia-cudnn-cu12`
  ("voice **GPU** sidecar … all assume CUDA 12.x"), and chatterbox installs
  `chatterbox-streaming --extra-index-url …/cu128`. Neither installer has a CPU
  code path, so `LAX_FORCE_CPU_TORCH` (set on these CI jobs) is a no-op for them.
  The CI jobs run on GPU-less `windows-latest` and upload
  `lite-venv-cpu-py311.zip` / `chatterbox-venv-cpu-py311.zip` — but those venvs
  contain CUDA-only packages. On a CPU-only end-user box `onnxruntime-gpu` finds
  no CUDA providers (the lite installer's own verify step even prints CUDA
  troubleshooting). So the "cpu" artifacts can't run on CPU.
- **Why not fixed here:** CPU-ifying a GPU sidecar (swap `onnxruntime-gpu` →
  `onnxruntime`, drop the `nvidia-*` wheels, use the CPU torch index) is a
  dependency-graph change that must be validated by actually building and
  running the venv on a CPU box — it can't be verified by inspection, and a
  wrong change risks breaking the working GPU path while still not producing a
  functioning CPU venv.
- **Fix (needs maintainer decision + CI verification):** either build genuine
  CPU variants of the lite/chatterbox sidecars, or stop building/labeling them
  as `-cpu-` artifacts and drop the dead `LAX_FORCE_CPU_TORCH` from those two
  jobs.
- **Type:** build/CI structural gap · **Severity:** medium
