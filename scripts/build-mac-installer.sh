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
# Bundle metadata (Info.plist + icon) lives under installer/mac-bundle/ —
# was inside the checked-in .app skeleton, but having that directory
# tracked-as-a-.app made macOS treat the clone as a launchable (broken)
# app. The two real files are all we need; the .app structure gets
# re-created here at build time.
BUNDLE_SRC="installer/mac-bundle"

echo "[mac-build] target architecture: $RID"

rm -rf "$OUT_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# InstallerSourceTag pins the source version this installer downloads at
# runtime. CI passes ${{ github.ref_name }} (the git tag/branch);
# local-dev runs without the env var fall through to "main".
SRC_TAG="${INSTALLER_SOURCE_TAG:-main}"
echo "[mac-build] dotnet publish (self-contained single-file, source tag: $SRC_TAG)…"
dotnet publish installer/Installer.csproj \
    -c Release \
    -r "$RID" \
    --self-contained true \
    -p:PublishSingleFile=true \
    -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:PublishTrimmed=false \
    -p:InstallerSourceTag="$SRC_TAG" \
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

# Pull Info.plist + icon from the source dir so the bundle identifier,
# version, and icon stay consistent across releases.
cp "$BUNDLE_SRC/Info.plist" "$APP_DIR/Contents/Info.plist"
if [ -f "$BUNDLE_SRC/icon.icns" ]; then
    cp "$BUNDLE_SRC/icon.icns" "$APP_DIR/Contents/Resources/icon.icns"
fi

# Codesign. Two modes:
#   1. APPLE_SIGN_IDENTITY set → real Developer ID signing with hardened
#      runtime + secure timestamp + entitlements. Required for notarization;
#      gives users one-click install with no Gatekeeper prompt.
#   2. Unset → ad-hoc (-). Lets the .app launch locally for dev iteration
#      but users get an "unidentified developer" warning.
# CI sets APPLE_SIGN_IDENTITY from the MACOS_SIGN_IDENTITY secret after
# importing the .p12 into a temp keychain.
if command -v codesign >/dev/null 2>&1; then
    if [ -n "${APPLE_SIGN_IDENTITY:-}" ]; then
        echo "[mac-build] Developer ID codesign: $APPLE_SIGN_IDENTITY"
        ENT_ARG=()
        if [ -f "$BUNDLE_SRC/entitlements.plist" ]; then
            ENT_ARG=(--entitlements "$BUNDLE_SRC/entitlements.plist")
        fi
        # Sign the inner Mach-O first, then the bundle. Hardened runtime
        # rejects signing an outer bundle whose inner binaries are unsigned
        # under the same identity.
        codesign --force --sign "$APPLE_SIGN_IDENTITY" \
            --options=runtime --timestamp \
            "${ENT_ARG[@]}" \
            "$APP_DIR/Contents/MacOS/install"
        codesign --force --sign "$APPLE_SIGN_IDENTITY" \
            --options=runtime --timestamp \
            "${ENT_ARG[@]}" \
            "$APP_DIR"
        echo "[mac-build] verifying signature…"
        codesign --verify --strict --verbose=2 "$APP_DIR"
    else
        echo "[mac-build] ad-hoc codesign (no APPLE_SIGN_IDENTITY)…"
        codesign --force --deep --sign - "$APP_DIR" || \
            echo "[mac-build] codesign failed — .app will trigger Gatekeeper." >&2
    fi
fi

echo "[mac-build] built: $APP_DIR"
echo "[mac-build] binary size: $(du -h "$APP_DIR/Contents/MacOS/install" | cut -f1)"
