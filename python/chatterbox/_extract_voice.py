"""Helper: pull a clean voice clip from a YouTube video for Chatterbox cloning.

Usage:
  python _extract_voice.py <youtube_url> <start_seconds> <duration_seconds> [--no-separate]

  python _extract_voice.py "https://www.youtube.com/watch?v=rx9usNnGkjc" 90 20

Steps:
  1. yt-dlp downloads best audio-only stream
  2. Trims to [start, start+duration] via ffmpeg (bundled imageio_ffmpeg)
  3. Optional: audio_separator (UVR-MDX-NET) splits vocals from BGM/SFX
  4. Saves as 24kHz mono WAV to /tmp/voice-clip-<timestamp>.wav

Output WAV is ready to upload via "+ Add a Chatterbox voice…" in chat.

Run with the RVC venv (has yt-dlp + audio-separator + UVR weights already):
  ~/.lax/python-rvc/venv/Scripts/python.exe python/chatterbox/_extract_voice.py ...
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="YouTube URL")
    ap.add_argument("start", type=float, help="Start time in seconds (e.g. 90 for 1:30)")
    ap.add_argument("duration", type=float, help="Clip length in seconds (10-30 ideal)")
    ap.add_argument("--no-separate", action="store_true", help="Skip vocal isolation (faster, but BGM/SFX leak through)")
    ap.add_argument("--output", default=None, help="Output WAV path (default /tmp/voice-clip-<ts>.wav)")
    args = ap.parse_args()

    if args.duration < 5 or args.duration > 60:
        print(f"WARN: duration {args.duration}s — Chatterbox prefers 10-30s of clean speech", file=sys.stderr)

    out = args.output or f"/tmp/voice-clip-{int(time.time())}.wav"

    # 1) yt-dlp → best audio
    work = Path(tempfile.mkdtemp(prefix="ytclip-"))
    try:
        raw = work / "raw.m4a"
        print(f"[1/3] downloading audio from {args.url} ...")
        try:
            from yt_dlp import YoutubeDL
        except ImportError:
            sys.exit("yt_dlp missing — run from the RVC venv (~/.lax/python-rvc/venv)")
        ydl_opts = {
            "format": "bestaudio[ext=m4a]/bestaudio",
            "outtmpl": str(work / "raw.%(ext)s"),
            "quiet": True,
            "noprogress": True,
        }
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(args.url, download=True)
            actual = list(work.glob("raw.*"))[0]
        print(f"  downloaded {actual.name} ({actual.stat().st_size // (1024 * 1024)} MB)")

        # 2) Trim + resample to 24kHz mono via bundled ffmpeg
        try:
            import imageio_ffmpeg
            ff = imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError:
            sys.exit("imageio-ffmpeg not installed; pip install imageio-ffmpeg")
        trimmed = work / "trimmed.wav"
        print(f"[2/3] trimming [{args.start:.1f}s, +{args.duration:.1f}s] ...")
        r = subprocess.run([
            ff, "-y", "-loglevel", "error",
            "-ss", str(args.start),
            "-t", str(args.duration),
            "-i", str(actual),
            "-ac", "1", "-ar", "24000",
            str(trimmed),
        ], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"ffmpeg failed: {r.stderr}")
        print(f"  trimmed: {trimmed.stat().st_size // 1024} KB")

        # 3) Optional: separate vocals from BGM/SFX
        if args.no_separate:
            shutil.copy(trimmed, out)
        else:
            print(f"[3/3] separating vocals (UVR-MDX-NET) ...")
            try:
                # Reuse the RVC venv's audio_separator (UVR weights already cached)
                # Set env so it doesn't dump output into cwd.
                os.environ.setdefault("AUDIO_SEPARATOR_MODELS_DIR", os.path.expanduser("~/.lax/rvc/models/audio_separator"))
                from audio_separator.separator import Separator
                sep_dir = work / "sep"
                sep_dir.mkdir()
                sep = Separator(output_dir=str(sep_dir), output_format="WAV")
                sep.load_model("UVR-MDX-NET-Voc_FT.onnx")
                outputs = sep.separate(str(trimmed))
                # outputs is a list of relative paths like ["filename_(Vocals).wav", "filename_(Instrumental).wav"]
                vocals_path = None
                for p in outputs:
                    full = sep_dir / p if not Path(p).is_absolute() else Path(p)
                    if not full.exists():
                        # audio_separator may return absolute paths or just basenames
                        candidates = list(sep_dir.glob("*Vocals*.wav"))
                        if candidates:
                            full = candidates[0]
                    if "vocal" in str(full).lower():
                        vocals_path = full
                        break
                if vocals_path is None:
                    vocals_candidates = list(sep_dir.glob("*Vocals*.wav"))
                    if vocals_candidates:
                        vocals_path = vocals_candidates[0]
                if vocals_path is None:
                    raise RuntimeError(f"separator returned no vocals file (got {outputs})")
                # Resample vocals back to 24kHz mono (separator may emit stereo / 44.1kHz)
                r2 = subprocess.run([
                    ff, "-y", "-loglevel", "error",
                    "-i", str(vocals_path),
                    "-ac", "1", "-ar", "24000",
                    out,
                ], capture_output=True, text=True)
                if r2.returncode != 0:
                    sys.exit(f"final ffmpeg failed: {r2.stderr}")
                print(f"  vocals isolated, dropped BGM/SFX")
            except Exception as e:
                print(f"  WARN: separator failed ({e}), using trimmed audio as-is")
                shutil.copy(trimmed, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    sz = Path(out).stat().st_size
    print()
    print(f"DONE: {out} ({sz // 1024} KB)")
    print(f"Upload via: chat picker -> '+ Add a Chatterbox voice...' -> name 'Optimus' -> pick this WAV")


if __name__ == "__main__":
    main()
