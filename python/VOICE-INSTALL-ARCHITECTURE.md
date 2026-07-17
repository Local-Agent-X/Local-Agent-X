# Voice sidecar install architecture

Three install paths, in order of preference for non-tech users.

> **Scope:** the artifact, lockfile, and verify-imports machinery below was
> fully implemented in the GPT-SoVITS installer, which was removed along with
> that engine (2026-07). The Lite (`python/voice/`) and Chatterbox
> (`python/chatterbox/`) installers are single-pass pip installs — they do a
> CUDA smoke test / import sanity check, not the full pipeline. Treat paths
> #1 and #2 as the target design until those installers are wired; the
> removed implementation is recoverable from git history
> (`python/sovits/install.ps1` before the removal commit).

## 1. Pre-built artifact (production, recommended)

How it works:
- Maintainer publishes a Git tag (e.g. `v1.2.0-voice`)
- GitHub Actions ([build-voice-artifacts.yml](../.github/workflows/build-voice-artifacts.yml))
  builds each sidecar venv on a clean Windows runner, packs it as a zip,
  uploads to the matching release
- An installer that implements this path reads its
  `LAX_<SIDECAR>_VENV_ARTIFACT_URL` env var (or `~/.lax/voice-bundles.json`);
  when set, install becomes:
  1. Download the zip (single ~3-5 GB file)
  2. Verify SHA-256
  3. Extract to the sidecar's venv dir (`~/.lax/python-voice/venv` for Lite,
     `~/.lax/python-chatterbox/venv` for Chatterbox — the dir name is not
     the tier id)
  4. Run verify-imports pass
  5. Done

Why this is the right answer for non-tech users:
- AV scans the zip ONCE at download time (not per-wheel)
- No pip resolution → no upstream drift surprises
- No network during install → works offline once downloaded
- Single signed artifact → easier to trust

To configure on a fresh box, drop `~/.lax/voice-bundles.json`:

```json
{
  "lite":       { "url": "https://github.com/.../lite-venv-cpu-py311.zip",       "sha256": "..." },
  "chatterbox": { "url": "https://github.com/.../chatterbox-venv-cpu-py311.zip", "sha256": "..." }
}
```

The `lite` and `chatterbox` keys are reserved — no installer consumes them
yet (the only consumer was the removed GPT-SoVITS installer).

## 2. Lockfile install (deterministic from-source)

How it works:
- The design: a `requirements.lock` frozen by `pip freeze` after a clean
  bootstrap on a clean runner. **Note:** no `requirements.lock` is committed
  for any sidecar today, and no current installer checks for one
- An installer implementing this path prefers the lockfile when present —
  every dep version is pinned exactly, no upstream drift
- Verify-imports pass at the end catches AV-corrupted wheels

Why this is the second-best option:
- Still does pip resolution (slow, AV-vulnerable)
- But deps are reproducible, so a known-good set never breaks unless
  WE bump the lock

Lock-update workflow:
1. On a clean Windows VM, run `install.ps1` from scratch (bootstrap path)
2. Verify all sidecars start clean and synth/transcribe end-to-end
3. `pip freeze > python/<sidecar>/requirements.lock` from the venv
4. Commit the new lock + tag a release

## 3. Bootstrap from upstream (what Lite + Chatterbox do today)

How it works:
- No lockfile, no artifact URL — install.ps1 / install.sh run pip directly:
  - Lite: pinned torch + `pip install -r requirements.txt`, then the
    `python/voice/_smoke.py` verify-imports pass
  - Chatterbox: `pip install chatterbox-streaming` from the cu128 index +
    fastapi/uvicorn/soundfile, then an `import chatterbox` smoke test

When this path runs:
- Every user install today (it's the only implemented path)
- Dev machines doing a fresh bootstrap to GENERATE a new lock or artifact

Why it's the worst option for users:
- Floats with whatever upstream pushed
- Downloads many small wheels (each scanned by AV separately)
- Slow (pip resolution + many small downloads = 10-30 min)
- Vulnerable to mid-stream AV interference

The Lite installer's verify-imports pass (`python/voice/_smoke.py`) catches
the common silent failure (AV deletes wheels mid-extract, pip says success
anyway). When it fires, the script outputs explicit Windows Defender
exclusion instructions — no traceback, just "Add %USERPROFILE%\.lax to
exclusions and click Reinstall."

## Adding a new sidecar

1. Drop `server.py` + `install.ps1` + `install.sh` in `python/<name>/` (both
   installers are required — `tiers.ts` selects between them via
   `INSTALLER_EXT` per platform, so omitting `install.sh` breaks Mac/Linux)
2. Add a tier entry to the `TIERS` array in
   `src/routes/bridges/voice-setup/tiers.ts` (`voice-setup.ts` is only a
   re-export shim). The `VoiceTier` interface requires: id, label, port,
   venvDir, installerPath, startCmd, healthUrl, description, diskFootprint
   (plus optional kind, procMatch)
3. Add a build job to `.github/workflows/build-voice-artifacts.yml`
4. Run the lock workflow once, commit the lock
5. (Optional) add the artifact URL to your fleet's voice-bundles.json
