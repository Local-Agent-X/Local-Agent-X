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

## Popup-mode Google sign-in renders blank in the in-app browser, and the popup's failure is never logged

- **Where:** [desktop/src/browser-view-popups.ts](../desktop/src/browser-view-popups.ts),
  [desktop/src/browser-partition.ts:346](../desktop/src/browser-partition.ts#L346)
  (`viewWebPreferences`),
  [desktop/src/embedded-chrome-identity.ts:29](../desktop/src/embedded-chrome-identity.ts#L29)
  (`identityOverrideEnabled = false`)
- **What:** Observed 2026-09-22 on LinkedIn → "Continue with Google". The popup
  window opens, titled "Sign In - Google Accounts", and paints nothing but
  white. Sign-in does not visibly complete. The user then chose LinkedIn's
  "Sign in with email" instead, at which point a Google account badge appeared
  in-page and signed them in via Google.
- **Cause is NOT isolated.** Two readings fit the evidence and this entry
  deliberately does not pick one:
  1. *Google refuses the embedded browser.* `identityOverrideEnabled` is false
     by design (a 2026-07-30 bisect found Chrome impersonation is refused by
     Cloudflare while the native UA passes), and the UA normalization strips
     only the app token — the `Electron/…` token survives. Google blocks
     sign-in from embedded browsers. Under this reading the in-page badge came
     from a Google session already present in the partition: the browser
     history shows `accounts.google.com/v3/signin/accountchooser` →
     `dash.cloudflare.com/login/google` on 2026-07-31 in `lax-profile-v2`.
  2. *The popup authenticated but never painted.* The popup's webPreferences
     are unremarkable — no preload, `contextIsolation`, `sandbox`,
     same partition — so nothing local obviously blanks it, and the account
     badge appearing immediately afterwards is consistent with the popup
     having established state.
- **Decisive test (not yet run):** sign out of Google inside the
  `lax-profile-v2` partition, then retry "Continue with Google". If sign-in
  still completes behind a blank popup, it is a paint defect and fixable here;
  if it does not, it is Google's embedded-browser policy and the workaround
  below is the only answer.
- **Second, independent defect — FIXED 2026-09-22:** the episode produced no
  log line at all, so nobody could tell reading 1 from reading 2 after the
  fact. Adopted popups now trace their whole lifetime to `desktop-stdio.log`
  ([browser-view-popups.ts](../desktop/src/browser-view-popups.ts)): opened,
  each main-frame navigation, finished load, a real load failure, a dead or
  unresponsive renderer, closed, and a cap denial. The SUCCESS path is logged
  deliberately — `did-fail-load` alone stays silent for this bug, because the
  load does not fail; a "finished load" line beside a white window is what
  isolates it to paint or page content, and its absence isolates it to the
  network. Only origins are written, never URLs, since an OAuth URL carries a
  live credential. **The next occurrence should therefore be diagnosable from
  the log alone** — re-read it before re-running the decisive test above.
- **Workaround:** use the site's own email/password sign-in where it exists
  ("Sign in with email" on LinkedIn). Do not re-enable the Chrome identity
  override to chase this — that path is already known to break Cloudflare.
- **Type:** unverified-cause + observability gap · **Severity:** medium
