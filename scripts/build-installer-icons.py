"""Build the cross-platform installer assets.

- Generates `Install Local Agent X.app/Contents/Resources/icon.icns` from public/icon.png.
- Generates the .app bundle's Info.plist and MacOS/install shim if missing.
- Compiles `Install Local Agent X.exe` from scripts/installer-launcher/Launcher.cs
  using the .NET Framework csc.exe (Windows only). Skipped on non-Windows hosts.

Run from the repo root: `python scripts/build-installer-icons.py`
"""
from __future__ import annotations

import io
import os
import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC_PNG = REPO / "public" / "icon.png"
SRC_ICO = REPO / "public" / "icon.ico"
APP = REPO / "Install Local Agent X Mac Installer.app"
EXE = REPO / "Install Local Agent X Windows Installer.exe"
LAUNCHER_CS = REPO / "scripts" / "installer-launcher" / "Launcher.cs"


def png_bytes(img: Image.Image, size: int) -> bytes:
    resized = img.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    resized.save(buf, format="PNG")
    return buf.getvalue()


def build_icns(out: Path) -> None:
    src = Image.open(SRC_PNG).convert("RGBA")
    # Make square by padding (preserve aspect, center).
    side = max(src.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(src, ((side - src.width) // 2, (side - src.height) // 2))
    chunks: list[tuple[bytes, bytes]] = []
    # OSType -> resolution. Embed common sizes Finder/Dock use.
    for ostype, size in [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
    ]:
        chunks.append((ostype, png_bytes(canvas, size)))
    body = b"".join(ostype + struct.pack(">I", len(data) + 8) + data for ostype, data in chunks)
    file_size = 8 + len(body)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"icns" + struct.pack(">I", file_size) + body)
    print(f"[icns] wrote {out.relative_to(REPO)} ({file_size:,} bytes, {len(chunks)} sizes)")


INFO_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Install Local Agent X</string>
    <key>CFBundleDisplayName</key>
    <string>Install Local Agent X</string>
    <key>CFBundleIdentifier</key>
    <string>com.localagentx.installer</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>CFBundleExecutable</key>
    <string>install</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
"""

# The .app's executable resolves the repo root by walking up out of the .app bundle
# (three parents: MacOS -> Contents -> .app -> repo) and then exec'ing install.command.
INSTALL_SHIM = """#!/bin/bash
# Local Agent X — macOS .app installer shim.
# Resolves the repo root (parent of this .app bundle) and hands off to install.command,
# which already lives at the repo root and contains the cross-platform install logic.
set -e
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
CMD="$REPO_DIR/install.command"
if [ ! -x "$CMD" ]; then
    if [ -f "$CMD" ]; then chmod +x "$CMD"; else
        osascript -e "display dialog \\"install.command not found at $CMD\\" buttons {\\"OK\\"} with icon stop"
        exit 1
    fi
fi
# Open Terminal so the user sees install progress (Finder double-click doesn't give us a tty).
osascript <<EOF
tell application "Terminal"
    activate
    do script "\\"$CMD\\""
end tell
EOF
"""


def build_app_bundle() -> None:
    contents = APP / "Contents"
    macos = contents / "MacOS"
    resources = contents / "Resources"
    for d in (contents, macos, resources):
        d.mkdir(parents=True, exist_ok=True)
    (contents / "Info.plist").write_text(INFO_PLIST, encoding="utf-8")
    shim = macos / "install"
    shim.write_text(INSTALL_SHIM, encoding="utf-8", newline="\n")
    # chmod is no-op on Windows but git will track the exec bit when committed
    # from a POSIX checkout; we set it via `git update-index --chmod=+x` below.
    try:
        os.chmod(shim, 0o755)
    except OSError:
        pass
    build_icns(resources / "icon.icns")
    print(f"[app] wrote {APP.relative_to(REPO)}/ (.app bundle)")


def find_csc() -> Path | None:
    candidates = [
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe",
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET" / "Framework" / "v4.0.30319" / "csc.exe",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def build_windows_exe() -> None:
    if sys.platform != "win32":
        print("[exe] skipped (not on Windows)")
        return
    csc = find_csc()
    if csc is None:
        print("[exe] skipped: csc.exe not found (install .NET Framework 4.x)")
        return
    cmd = [
        str(csc),
        "/nologo",
        "/target:exe",
        f"/win32icon:{SRC_ICO}",
        f"/out:{EXE}",
        str(LAUNCHER_CS),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("[exe] FAILED:")
        print(result.stdout)
        print(result.stderr)
        sys.exit(result.returncode)
    print(f"[exe] wrote {EXE.relative_to(REPO)} ({EXE.stat().st_size:,} bytes)")


def main() -> None:
    if not SRC_PNG.exists():
        sys.exit(f"missing {SRC_PNG}")
    if not SRC_ICO.exists():
        sys.exit(f"missing {SRC_ICO}")
    build_app_bundle()
    build_windows_exe()
    print("done.")


if __name__ == "__main__":
    main()
