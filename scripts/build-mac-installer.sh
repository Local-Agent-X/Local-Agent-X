#!/usr/bin/env bash
# Build the macOS .app installer bundle for Local Agent X.
#
# Wraps the published Avalonia binary in the standard macOS .app structure
# so users can double-click to install. Runs locally on a Mac OR on a
# GitHub Actions macos-latest runner.
#
# Output: installer/dist-mac/Install Local Agent X Mac Installer.app/
#
# Override the architecture target via MAC_BUILD_RID (default: osx-arm64).
# Universal binaries (arm64 + x64 in one .app) need a separate `lipo` step;
# Phase 3 ships arm64 only since Apple Silicon dominates the 2026+ install
# base. Intel-Mac support is a future flag.

set -euo pipefail

cd "$(dirname "$0")/.."

RID="${MAC_BUILD_RID:-osx-arm64}"
APP_NAME="Install Local Agent X Mac Installer.app"
OUT_DIR="installer/dist-mac"
APP_DIR="$OUT_DIR/$APP_NAME"
SRC_APP="Install Local Agent X Mac Installer.app"

echo "[mac-build] target architecture: $RID"

rm -rf "$OUT_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

echo "[mac-build] dotnet publish (self-contained single-file)…"
dotnet publish installer/Installer.csproj \
    -c Release \
    -r "$RID" \
    --self-contained true \
    -p:PublishSingleFile=true \
    -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:PublishTrimmed=false \
    --nologo

PUB="installer/bin/Release/net8.0/$RID/publish"
BINARY="$PUB/LocalAgentXInstaller"

if [ ! -f "$BINARY" ]; then
    echo "ERROR: published binary not found at $BINARY" >&2
    ls -la "$PUB" || true
    exit 1
fi

# Copy as 'install' to match CFBundleExecutable in Info.plist.
cp "$BINARY" "$APP_DIR/Contents/MacOS/install"
chmod +x "$APP_DIR/Contents/MacOS/install"

# Pull Info.plist + icon from the existing checked-in .app so the
# bundle identifier, version, icon all stay consistent across releases.
cp "$SRC_APP/Contents/Info.plist" "$APP_DIR/Contents/Info.plist"
if [ -f "$SRC_APP/Contents/Resources/icon.icns" ]; then
    cp "$SRC_APP/Contents/Resources/icon.icns" "$APP_DIR/Contents/Resources/icon.icns"
fi

# Ad-hoc codesign — satisfies Gatekeeper's "must be signed to run" check
# without establishing trust. Without it, modern macOS refuses to launch
# the .app at all (not even with right-click → Open). With ad-hoc the user
# still sees the "unidentified developer" prompt once, but they CAN
# right-click → Open to bypass. Real Apple Developer ID signing is Phase 4.
if command -v codesign >/dev/null 2>&1; then
    echo "[mac-build] ad-hoc codesign…"
    codesign --force --deep --sign - "$APP_DIR" || \
        echo "[mac-build] codesign failed — .app will trigger Gatekeeper. Consider real signing." >&2
fi

echo "[mac-build] built: $APP_DIR"
echo "[mac-build] binary size: $(du -h "$APP_DIR/Contents/MacOS/install" | cut -f1)"
