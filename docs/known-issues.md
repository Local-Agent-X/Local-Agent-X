# Known issues — code-level bugs

These are **code** defects (stale comments, broken package metadata, build/CI
mismatches) surfaced by the docs-sync audit on 2026-06-04. They are *not* doc
bugs — the prose docs were corrected separately — but each was verified against
source and left for a scoped code fix. Remove an entry when its fix lands.

> Tracked here because the repo has no GitHub issue tooling configured locally
> (`gh` not installed). Convert to GitHub issues if/when preferred.

## 1. Stale bind-timeout comment in self-edit sandbox

- **Where:** [src/self-edit-sandbox.ts:13](../src/self-edit-sandbox.ts#L13)
- **What:** The header comment says the probe "must bind within 60s." The real
  ceiling is `BIND_TIMEOUT_MS = 150_000` (150s) in
  [src/self-edit-sandbox-gates.ts:33](../src/self-edit-sandbox-gates.ts#L33);
  the gate error message already renders 150s at runtime.
- **Fix:** Update the comment 60s → 150s (or reference `BIND_TIMEOUT_MS`).
- **Type:** stale comment · **Severity:** low

## 2. Dead reference to deleted `src/ari-kernel.ts`

- **Where:** [src/ari-kernel/index.ts:1](../src/ari-kernel/index.ts#L1)
- **What:** Comment reads "Legacy `src/ari-kernel.ts` re-exports from here," but
  that single-file shim no longer exists — the kernel is the `src/ari-kernel/`
  directory only.
- **Fix:** Drop or reword the comment; nothing re-exports from a legacy file.
- **Type:** stale comment · **Severity:** low

## 3. Dangling `LICENSE.md` reference in arikernel package metadata

- **Where:** every `packages/arikernel/*/package.json` (`core`, `runtime`,
  `taint-tracker`, `policy-engine`, `audit-log`, `tool-executors`)
- **What:** Each declares `"license": "SEE LICENSE IN LICENSE.md"`, but no
  `LICENSE.md` ships under `packages/arikernel/`. The only license on disk is
  the repo-root Commons Clause [LICENSE](../LICENSE).
- **Fix:** Either add the referenced `LICENSE.md`, or change the `license` field
  to match the repo's actual license (Apache-2.0 + Commons Clause).
- **Type:** broken package metadata · **Severity:** medium

## 4. torch pin diverges between Windows and POSIX sovits installers

- **Where:** [python/sovits/install.ps1:206](../python/sovits/install.ps1#L206)
  vs [python/sovits/install.sh:100](../python/sovits/install.sh#L100)
- **What:** Windows pins `torch==2.6.0 torchaudio==2.6.0`; macOS/Linux pins
  `torch==2.5.1 torchaudio==2.5.1`. The two platforms ship different torch
  versions for the same sidecar.
- **Fix:** Reconcile to one version, or document why the divergence is
  intentional (the ps1 has a comment about the torchcodec/FFmpeg issue driving
  2.6.0).
- **Type:** build inconsistency · **Severity:** medium

## 5. `LAX_FORCE_CPU_TORCH` set in CI but read by no installer

- **Where:** [.github/workflows/build-voice-artifacts.yml:69,111,144](../.github/workflows/build-voice-artifacts.yml#L69)
- **What:** Every voice-artifact CI job sets `LAX_FORCE_CPU_TORCH=1` to force CPU
  torch on GPU-less runners, but no installer (`*.ps1`/`*.sh`/`*.mjs`) reads the
  variable — it is dead. The sovits installer happens to pick the CPU index from
  `nvidia-smi` so CI still works, but the env var is a no-op. Separately,
  `python/voice/requirements.txt` hard-pins `onnxruntime-gpu` + CUDA torch
  wheels with no CPU fallback, so the CI `build-lite` job may not produce a
  working CPU artifact regardless.
- **Fix:** Either honor `LAX_FORCE_CPU_TORCH` in the installers' torch-index
  selection, or remove it from CI and document the `nvidia-smi`-based fallback.
  Audit whether `build-lite` can produce a CPU artifact at all.
- **Type:** dead CI env var / build gap · **Severity:** medium

## 6. Stale `src/agent-store.ts` path in catalog comment

- **Where:** [src/agents/catalog.ts:10](../src/agents/catalog.ts#L10)
- **What:** Comment cites the seed source as `src/agent-store.ts`. That file
  doesn't exist — the store is the `src/agent-store/` directory
  (`template-store.ts`, re-exported via `index.js`); the actual imports at
  lines 36/38 already use `../agent-store/index.js`.
- **Fix:** Update the comment path to `src/agent-store/`.
- **Type:** stale comment · **Severity:** low

## 7. resampler comment says `ceil`, code uses `floor`

- **Where:** [src/voice/realtime/resampler.ts:16-17](../src/voice/realtime/resampler.ts#L16)
- **What:** Comment reads `Output length = ceil(input * 24/16)`, but the code is
  `Math.floor((input.length * 3) / 2)`. The `floor` is the correct/intended
  choice for fixed-frame chunks; the comment is wrong.
- **Fix:** Correct the comment `ceil` → `floor`.
- **Type:** stale comment · **Severity:** low
