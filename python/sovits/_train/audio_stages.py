"""Audio prep stages: download, trim, denoise (UVR5), slice."""
from __future__ import annotations

import shutil
from pathlib import Path

from .constants import FFMPEG, PYTHON, REPO
from .protocol import fail, log, run, stage


def stage_download(args, work_dir: Path) -> Path:
    """Pull audio from URL via yt-dlp, or copy from --source-file."""
    out = work_dir / "source.wav"
    if args.source_file:
        if not Path(args.source_file).exists():
            fail(f"source file not found: {args.source_file}")
        log(f"copying {args.source_file} -> {out}")
        shutil.copy(args.source_file, out)
        return out
    if not args.source_url:
        fail("must provide --source-url or --source-file")
    if not FFMPEG:
        fail("ffmpeg not found on PATH (set LAX_FFMPEG)")
    stage("download", "Downloading audio from URL", 5, eta=60)
    run([
        PYTHON, "-m", "yt_dlp", "-x", "--audio-format", "wav", "--audio-quality", "0",
        "--ffmpeg-location", str(Path(FFMPEG).parent),
        "--postprocessor-args", "ffmpeg:-ac 1 -ar 32000",
        "-o", str(work_dir / "source.%(ext)s"),
        args.source_url,
    ])
    if not out.exists():
        fail(f"download produced no source.wav at {out}")
    return out


def stage_trim(src: Path, work_dir: Path, args) -> Path:
    """Optional: trim silence-padding + normalize. For now just copies as-is."""
    stage("trim", "Preparing audio", 10)
    return src  # slice_audio handles loudness normalization, no trim needed


def stage_denoise(src: Path, work_dir: Path) -> Path:
    """Vocal isolation: strip music/noise so we train on clean speech.
    Uses GPT-SoVITS's bundled UVR5 (HP5 model). Skips cleanly if weights
    aren't installed and warns the caller — the pipeline will train on
    raw audio (acceptable for clean sources, lossy for music-bedded ones)."""
    stage("denoise", "Isolating vocals (UVR5)", 15, eta=180)
    weights_dir = REPO / "tools" / "uvr5" / "uvr5_weights"
    candidates = sorted([p for p in weights_dir.glob("*.pth") if "main_vocal" in p.name.lower()])
    if not candidates:
        candidates = sorted(weights_dir.glob("HP5*.pth")) + sorted(weights_dir.glob("HP2*.pth"))
    if not candidates:
        log("UVR5 weights not installed — skipping denoise step. Train quality "
            "may suffer if source has music/noise. Run scripts/install-uvr5.py to enable.")
        return src
    model_path = candidates[0]
    log(f"using uvr5 model: {model_path.name}")

    out_root = work_dir / "denoised"
    out_root.mkdir(exist_ok=True)
    vocal_dir = out_root / "vocal"
    inst_dir = out_root / "instrumental"
    vocal_dir.mkdir(exist_ok=True)
    inst_dir.mkdir(exist_ok=True)

    # UVR5 wants stereo 44100. Reformat first.
    if not FFMPEG:
        log("ffmpeg missing — skipping denoise"); return src
    reformatted = work_dir / "source_44k_stereo.wav"
    run([FFMPEG, "-y", "-i", str(src), "-vn", "-acodec", "pcm_s16le",
         "-ac", "2", "-ar", "44100", str(reformatted)])

    # Split into 60s chunks to bound UVR5's spectrogram memory. UVR5 builds
    # a complex128 STFT of the entire input at once — for a 30-min source
    # that's ~10 GB and hits ArrayMemoryError on 16 GB systems with other
    # services loaded. 60s chunks keep each STFT under 350 MB.
    chunk_dir = work_dir / "uvr_chunks"
    chunk_dir.mkdir(exist_ok=True)
    run([FFMPEG, "-y", "-i", str(reformatted),
         "-f", "segment", "-segment_time", "60",
         "-c", "copy", str(chunk_dir / "chunk_%03d.wav")])
    chunks = sorted(chunk_dir.glob("chunk_*.wav"))
    log(f"split into {len(chunks)} chunks for UVR5 processing")

    # Inline UVR5 invocation per chunk — CPU because GPU is occupied by
    # api_v2 + lite sidecar (Whisper/Kokoro/VAD). CPU UVR5 takes ~10s per
    # 60s chunk on this hardware, so a 30-min source = ~5 min total.
    chunk_paths = "\n".join(f'    r"{c}",' for c in chunks)
    code = f"""
import sys, os
sys.path.insert(0, r"{REPO / 'tools' / 'uvr5'}")
import torch
if torch.cuda.is_available(): torch.cuda.empty_cache()
from vr import AudioPre
pre = AudioPre(agg=10, model_path=r"{model_path}", device="cpu", is_half=False)
chunks = [
{chunk_paths}
]
for i, c in enumerate(chunks):
    print(f"[uvr5] chunk {{i+1}}/{{len(chunks)}}: {{c}}", flush=True)
    pre._path_audio_(c, r"{inst_dir}", r"{vocal_dir}", "wav", False)
print("OK")
"""
    helper = work_dir / "_uvr5.py"
    helper.write_text(code, encoding="utf-8")
    run([PYTHON, str(helper)], cwd=REPO)

    # Concat all per-chunk vocal outputs in order
    vocals = sorted(vocal_dir.glob("*.wav"))
    if not vocals:
        log("UVR5 produced no vocal output — falling back to raw audio")
        return src
    log(f"UVR5 produced {len(vocals)} vocal chunk(s); concatenating")
    concat_list = work_dir / "_uvr_concat.txt"
    concat_list.write_text(
        "\n".join(f"file '{v.as_posix()}'" for v in vocals), encoding="utf-8")
    out = work_dir / "source_clean.wav"
    run([FFMPEG, "-y", "-f", "concat", "-safe", "0",
         "-i", str(concat_list), "-ac", "1", "-ar", "32000", str(out)])
    log(f"vocal-isolated source ready: {out.name}")
    return out


def stage_slice(src: Path, work_dir: Path) -> Path:
    """Cut source into 3-10s clips at silences."""
    stage("slice", "Slicing audio at silences", 20, eta=30)
    sliced_dir = work_dir / "sliced"
    sliced_dir.mkdir(exist_ok=True)
    # tools/slice_audio.py args: input output -34 4000 300 10 500 0.9 0.25 0 1
    run([
        PYTHON, "-s", "tools/slice_audio.py",
        str(src), str(sliced_dir),
        "-34", "4000", "300", "10", "500",
        "0.9", "0.25", "0", "1",
    ], cwd=REPO)
    n = sum(1 for _ in sliced_dir.glob("*.wav"))
    log(f"sliced into {n} clips")
    if n < 50:
        fail(f"only {n} clips after slicing; need at least 50 — try a longer source")
    return sliced_dir
