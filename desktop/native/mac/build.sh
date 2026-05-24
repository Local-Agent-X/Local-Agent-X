#!/usr/bin/env bash
# Build the lax-speech-mac helper as a universal (arm64 + x86_64) binary.
# Emits to ../dist-bin/lax-speech-mac which electron-builder picks up via
# the extraResources entry in package.json.
#
# Idempotent — re-runs are cheap (swiftc skips unchanged inputs only via
# timestamp checks, so we always rebuild but it's <1s).

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out_dir="$here/../dist-bin"
app="$out_dir/LaxSpeech.app"
macos="$app/Contents/MacOS"
mkdir -p "$macos"

# macOS TCC reads usage-description strings from a real bundle's Info.plist —
# the legacy `-sectcreate __TEXT __info_plist` trick gets ignored by Speech
# Recognition + Microphone gates (TCC SIGABRTs the helper before our code
# runs). So we wrap the universal binary in a minimal .app and copy the
# plist into Contents/. The Electron main process spawns
# .../LaxSpeech.app/Contents/MacOS/lax-speech-mac directly; the bundle is
# never user-visible.
plist="$here/Info.plist"

# Universal Mach-O — one helper covers Apple Silicon + Intel. Min deployment
# target matches the parent .app's LSMinimumSystemVersion (11.0).
swiftc \
  -target arm64-apple-macos11.0 \
  -O \
  -o "$macos/lax-speech-mac-arm64" \
  "$here/speech-helper.swift"

swiftc \
  -target x86_64-apple-macos11.0 \
  -O \
  -o "$macos/lax-speech-mac-x86_64" \
  "$here/speech-helper.swift"

lipo -create \
  "$macos/lax-speech-mac-arm64" \
  "$macos/lax-speech-mac-x86_64" \
  -output "$macos/lax-speech-mac"

rm "$macos/lax-speech-mac-arm64" "$macos/lax-speech-mac-x86_64"
chmod +x "$macos/lax-speech-mac"

cp "$plist" "$app/Contents/Info.plist"

# Ad-hoc sign for dev. The real Developer ID signature is applied by the
# parent electron-builder pass on .dmg packaging — this just lets the
# binary run + register with TCC during `npm run dev`. Sign nested
# components first (the Mach-O), then the bundle — `--deep` is deprecated
# by Apple but still works; safer to sign manually inside-out.
codesign --force --sign - "$macos/lax-speech-mac"
codesign --force --sign - "$app"

echo "[mac-speech] built $app"
