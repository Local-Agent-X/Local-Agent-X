"""End-to-end voice training pipeline.

Usage:
    python train_pipeline.py --name "Optimus Prime" --source-url "https://youtube.com/..." \\
                             [--source-file path.wav] [--epochs-sovits 8] [--epochs-gpt 15] \\
                             [--ref-start 0 --ref-duration 8]

Stdout protocol — each line is one of:
    STAGE: <id>|<label>|<pct>|<eta_sec>
    LOG:   <freeform message>
    DONE:  {clone_id, name}
    ERROR: <message>

Stages: download (5%) → trim (10%) → slice (20%) → asr (35%) → format (55%)
        → train_sovits (75%) → train_gpt (95%) → register (100%)

The orchestrator just chains the same scripts the GPT-SoVITS webui uses,
plus the existing /clones POST to register the new voice. Each script
runs as a subprocess so a crash doesn't take down the orchestrator.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO = Path(os.path.expanduser("~/.lax/sovits/repo"))
TRAINING_ROOT = Path(os.path.expanduser("~/.lax/sovits-training"))
PYTHON = sys.executable  # this script is launched via the GPTSoVits venv
FFMPEG = os.environ.get("LAX_FFMPEG") or shutil.which("ffmpeg")
SOVITS_API = os.environ.get("LAX_SOVITS_API_V2", "http://127.0.0.1:7011")
SOVITS_SIDECAR = os.environ.get("LAX_SOVITS_SIDECAR", "http://127.0.0.1:7012")


# A second sink for emit() lines so a user who closes the modal can still
# tail the live log later. Set once we know work_dir (in main()).
_LOG_FILE: "Path | None" = None

def emit(kind: str, payload: str) -> None:
    """Print a protocol line, flush stdout for the SSE relay, AND mirror to
    <workdir>/_pipeline.log so the bridge can tail it on demand."""
    line = f"{kind}: {payload}"
    print(line, flush=True)
    if _LOG_FILE is not None:
        try:
            with _LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


def stage(stage_id: str, label: str, pct: int, eta: int = 0) -> None:
    emit("STAGE", f"{stage_id}|{label}|{pct}|{eta}")


def log(msg: str) -> None:
    emit("LOG", msg)


def fail(msg: str) -> None:
    emit("ERROR", msg)
    sys.exit(1)


def run(cmd: list[str], cwd: Path | None = None, env_extra: dict | None = None) -> None:
    """Run a subprocess; surface stdout/stderr as LOG lines; raise on nonzero."""
    log(f"$ {' '.join(str(c) for c in cmd)}")
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.Popen(
        cmd, cwd=str(cwd) if cwd else None, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
    )
    assert proc.stdout
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            log(line[:300])
    rc = proc.wait()
    if rc != 0:
        fail(f"subprocess exited {rc}: {' '.join(str(c) for c in cmd[:3])}")


# ── Stage implementations ──

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


def stage_asr(sliced_dir: Path, work_dir: Path) -> Path:
    """Transcribe each clip with Faster-Whisper."""
    stage("asr", "Transcribing clips (Faster-Whisper)", 35, eta=180)
    asr_dir = work_dir / "asr"
    asr_dir.mkdir(exist_ok=True)
    run([
        PYTHON, "-s", "tools/asr/fasterwhisper_asr.py",
        "-i", str(sliced_dir), "-o", str(asr_dir),
        "-s", "large-v3-turbo", "-l", "auto", "-p", "float16",
    ], cwd=REPO)
    list_file = asr_dir / "sliced.list"
    if not list_file.exists():
        fail(f"ASR produced no list file at {list_file}")
    return list_file


def stage_format(list_file: Path, sliced_dir: Path, exp_name: str) -> None:
    """Run the 4-stage dataset prep: text/BERT, HuBERT, semantic, SV."""
    stage("format", "Extracting features (BERT, HuBERT, SV)", 55, eta=180)
    opt_dir = REPO / "logs" / exp_name
    opt_dir.mkdir(parents=True, exist_ok=True)
    base_env = {
        "inp_text": str(list_file),
        "inp_wav_dir": str(sliced_dir),
        "exp_name": exp_name,
        "i_part": "0", "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": "0",
        "opt_dir": str(opt_dir).replace("\\", "/"),
        "is_half": "True",
        "version": "v2Pro",
        "bert_pretrained_dir": "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
        "cnhubert_base_dir": "GPT_SoVITS/pretrained_models/chinese-hubert-base",
        "pretrained_s2G": "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth",
        "s2config_path": "GPT_SoVITS/configs/s2v2Pro.json",
        "sv_path": "GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt",
    }
    for script in [
        "GPT_SoVITS/prepare_datasets/1-get-text.py",
        "GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py",
        "GPT_SoVITS/prepare_datasets/3-get-semantic.py",
        "GPT_SoVITS/prepare_datasets/2-get-sv.py",
    ]:
        run([PYTHON, "-s", script], cwd=REPO, env_extra=base_env)

    # The format scripts write per-part shards (2-name2text-0.txt,
    # 6-name2semantic-0.tsv, etc.) since they're designed for parallel runs.
    # The trainers expect the merged final files, so concat the shards and
    # delete the parts. The webui does this same merge inline.
    for stem, ext in [("2-name2text", ".txt"), ("6-name2semantic", ".tsv")]:
        merged = opt_dir / f"{stem}{ext}"
        parts = sorted(opt_dir.glob(f"{stem}-*{ext}"))
        if not parts:
            log(f"warning: no shards found for {stem}{ext}")
            continue
        chunks = []
        for p in parts:
            chunks.append(p.read_text(encoding="utf-8").strip("\n"))
            p.unlink()
        merged.write_text("\n".join(chunks) + "\n", encoding="utf-8")
        log(f"merged {len(parts)} shard(s) -> {merged.name} ({merged.stat().st_size} bytes)")


def stage_train_sovits(exp_name: str, epochs: int) -> Path:
    """Fine-tune the SoVITS half. Outputs to SoVITS_weights_v2Pro/<name>_e<N>.pth."""
    stage("train_sovits", f"Training SoVITS ({epochs} epochs)", 75, eta=epochs * 90)
    cfg = REPO / "TEMP" / f"tmp_s2_{exp_name}.json"
    cfg.parent.mkdir(exist_ok=True)
    cfg_data = {
        "train": {
            "log_interval": 100, "eval_interval": 500, "seed": 1234, "epochs": epochs,
            "learning_rate": 0.0001, "betas": [0.8, 0.99], "eps": 1e-09,
            "batch_size": 6, "fp16_run": True, "lr_decay": 0.999875, "segment_size": 20480,
            "init_lr_ratio": 1, "warmup_epochs": 0, "c_mel": 45, "c_kl": 1.0,
            "text_low_lr_rate": 0.4, "grad_ckpt": False,
            "pretrained_s2G": "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth",
            "pretrained_s2D": "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2Pro.pth",
            "if_save_latest": True, "if_save_every_weights": True,
            "save_every_epoch": max(2, epochs // 2), "gpu_numbers": "0", "lora_rank": "32",
        },
        "data": {
            "max_wav_value": 32768.0, "sampling_rate": 32000, "filter_length": 2048,
            "hop_length": 640, "win_length": 2048, "n_mel_channels": 128,
            "mel_fmin": 0.0, "mel_fmax": None, "add_blank": True, "n_speakers": 300,
            "cleaned_text": True, "exp_dir": f"logs/{exp_name}",
        },
        "model": {
            "inter_channels": 192, "hidden_channels": 192, "filter_channels": 768,
            "n_heads": 2, "n_layers": 6, "kernel_size": 3, "p_dropout": 0.0,
            "resblock": "1", "resblock_kernel_sizes": [3, 7, 11],
            "resblock_dilation_sizes": [[1, 3, 5], [1, 3, 5], [1, 3, 5]],
            "upsample_rates": [10, 8, 2, 2, 2], "upsample_initial_channel": 512,
            "upsample_kernel_sizes": [16, 16, 8, 2, 2], "n_layers_q": 3,
            "use_spectral_norm": False, "gin_channels": 1024,
            "semantic_frame_rate": "25hz", "freeze_quantizer": True, "version": "v2Pro",
        },
        "s2_ckpt_dir": f"logs/{exp_name}", "content_module": "cnhubert",
        "save_weight_dir": "SoVITS_weights_v2Pro", "name": exp_name,
        "version": "v2Pro", "pretrain": None, "resume_step": None,
    }
    cfg.write_text(json.dumps(cfg_data, indent=2), encoding="utf-8")
    run([PYTHON, "-s", "GPT_SoVITS/s2_train.py", "--config", str(cfg)], cwd=REPO)
    candidates = sorted((REPO / "SoVITS_weights_v2Pro").glob(f"{exp_name}_e*.pth"))
    if not candidates:
        fail(f"SoVITS training produced no weights for {exp_name}")
    return candidates[-1]


def stage_train_gpt(exp_name: str, epochs: int) -> Path:
    """Fine-tune the GPT half. Outputs to GPT_weights_v2Pro/<name>-e<N>.ckpt."""
    stage("train_gpt", f"Training GPT ({epochs} epochs)", 95, eta=epochs * 60)
    cfg = REPO / "TEMP" / f"tmp_s1_{exp_name}.yaml"
    cfg.parent.mkdir(exist_ok=True)
    cfg.write_text(_s1_yaml(exp_name, epochs), encoding="utf-8")
    run([PYTHON, "-s", "GPT_SoVITS/s1_train.py", "--config_file", str(cfg)], cwd=REPO)
    candidates = sorted((REPO / "GPT_weights_v2Pro").glob(f"{exp_name}-e*.ckpt"))
    if not candidates:
        fail(f"GPT training produced no weights for {exp_name}")
    return candidates[-1]


def _s1_yaml(exp_name: str, epochs: int) -> str:
    return f"""train:
  seed: 1234
  epochs: {epochs}
  batch_size: 6
  save_every_n_epoch: {max(2, epochs // 3)}
  gradient_clip: 1.0
  if_save_latest: true
  if_save_every_weights: true
  half_weights_save_dir: GPT_weights_v2Pro
  exp_name: "{exp_name}"
  precision: 16-mixed
optimizer:
  lr: 0.01
  lr_init: 0.00001
  lr_end: 0.0001
  warmup_steps: 2000
  decay_steps: 40000
data:
  max_eval_sample: 8
  max_sec: 54
  num_workers: 0
  pad_val: 1024
model:
  vocab_size: 1025
  phoneme_vocab_size: 732
  embedding_dim: 512
  hidden_dim: 512
  head: 16
  linear_units: 2048
  n_layer: 24
  dropout: 0
  EOS: 1024
  random_bert: 0
inference:
  top_k: 15
  top_p: 1.0
  temperature: 1.0
output_dir: logs/{exp_name}/logs_s1_v2Pro
pretrained_s1: GPT_SoVITS/pretrained_models/s1v3.ckpt
train_semantic_path: logs/{exp_name}/6-name2semantic.tsv
train_phoneme_path: logs/{exp_name}/2-name2text.txt
"""


def stage_register(name: str, sovits_pth: Path, gpt_ckpt: Path,
                   ref_wav: Path, prompt_text: str) -> str:
    """POST to /clones to register the trained voice."""
    stage("register", "Registering voice in LAX", 100)
    import base64
    import urllib.request
    body = json.dumps({
        "name": name,
        "prompt_text": prompt_text,
        "ref_wav_b64": base64.b64encode(ref_wav.read_bytes()).decode("ascii"),
        "sovits_pth": str(sovits_pth).replace("\\", "/"),
        "gpt_ckpt": str(gpt_ckpt).replace("\\", "/"),
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{SOVITS_SIDECAR}/clones", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        result = json.loads(r.read().decode("utf-8"))
    return result["id"]


def make_ref_clip(sliced_dir: Path, list_file: Path, work_dir: Path,
                  ref_start: float, ref_duration: float) -> tuple[Path, str]:
    """Pick the first 3-10s clip with non-empty transcript as the reference.
    Returns (ref_wav_path, prompt_text)."""
    stage("ref", "Selecting reference clip", 50)
    with list_file.open(encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("|")
            if len(parts) < 4: continue
            wav_path, _, _, text = parts
            text = text.strip()
            if not text: continue
            wav = Path(wav_path)
            if not wav.exists(): continue
            ref_out = work_dir / "ref.wav"
            shutil.copy(wav, ref_out)
            log(f"reference clip: {wav.name} ({len(text)} chars)")
            return ref_out, text
    fail("no usable reference clip found in transcript list")
    return None, ""  # unreachable


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--name", required=True, help="Voice display name")
    p.add_argument("--source-url", help="YouTube/etc URL (yt-dlp)")
    p.add_argument("--source-file", help="Local audio file path")
    p.add_argument("--epochs-sovits", type=int, default=8)
    p.add_argument("--epochs-gpt", type=int, default=15)
    p.add_argument("--ref-start", type=float, default=0)
    p.add_argument("--ref-duration", type=float, default=8)
    p.add_argument("--denoise", action="store_true",
                   help="Run UVR5 vocal isolation before slicing (use for sources with music/noise)")
    p.add_argument("--resume", metavar="EXP_NAME",
                   help="Resume an in-progress training run by exp_name (e.g. voice_d3534964). "
                        "Skips any stage whose outputs already exist on disk.")
    args = p.parse_args()

    if args.resume:
        exp_name = args.resume
        work_dir = TRAINING_ROOT / "datasets" / exp_name
        if not work_dir.exists():
            fail(f"resume target workdir not found: {work_dir}")
        # Recover the run's saved name + source URL from _meta.json so the
        # user doesn't have to retype them. Falls back to whatever was
        # passed via --name only when the meta file is missing or unreadable.
        meta_path = work_dir / "_meta.json"
        try:
            saved_meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if saved_meta.get("name") and not args.name:
                args.name = saved_meta["name"]
            if saved_meta.get("source_url") and not args.source_url:
                args.source_url = saved_meta["source_url"]
            if saved_meta.get("source_file") and not args.source_file:
                args.source_file = saved_meta["source_file"]
            log(f"recovered meta: name={args.name!r}")
        except Exception:
            pass
        # Guard against accidental concurrent resumes on the same exp_name —
        # two trainers writing the same logs/<exp>/ + weights file would
        # corrupt each other. A tiny .lock file with our PID + start time
        # is good enough; the OS frees it when the process dies.
        lock = work_dir / "_resume.lock"
        if lock.exists():
            try:
                content = lock.read_text(encoding="utf-8").strip().split("\n")
                other_pid = int(content[0]) if content else 0
                # Best-effort liveness check (Windows: psutil if installed, else trust the lock)
                alive = True
                try:
                    import psutil
                    alive = psutil.pid_exists(other_pid)
                except Exception:
                    pass
                if alive:
                    fail(f"another resume of {exp_name} is already running "
                         f"(PID {other_pid}). Kill it first or wait for it to finish.")
                else:
                    log(f"stale lock from dead PID {other_pid}, taking over")
            except Exception:
                pass
        lock.write_text(f"{os.getpid()}\n{int(time.time())}\n", encoding="utf-8")
        import atexit
        atexit.register(lambda: lock.unlink(missing_ok=True))
        log(f"RESUMING run {exp_name} (lock acquired)")
    else:
        exp_name = "voice_" + uuid.uuid4().hex[:8]
        work_dir = TRAINING_ROOT / "datasets" / exp_name
        work_dir.mkdir(parents=True, exist_ok=True)
        # Persist the run's identity right away so a later --resume can
        # recover the name + source without the user having to retype them.
        try:
            meta = {
                "name": args.name,
                "source_url": args.source_url,
                "source_file": args.source_file,
                "epochs_sovits": args.epochs_sovits,
                "epochs_gpt": args.epochs_gpt,
                "denoise": bool(args.denoise),
                "created_at": int(time.time()),
            }
            (work_dir / "_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        except Exception as e:
            log(f"warning: failed to persist _meta.json: {e}")
    # Mirror future emit() lines into <workdir>/_pipeline.log. Created here
    # rather than at module load because work_dir isn't known until now.
    global _LOG_FILE
    _LOG_FILE = work_dir / "_pipeline.log"
    try:
        # Append-only — preserves any earlier resume's log entries.
        _LOG_FILE.touch(exist_ok=True)
    except Exception:
        _LOG_FILE = None

    log(f"workdir: {work_dir}")
    log(f"exp_name: {exp_name}")

    # Stage-skip: each stage checks its expected output and bails out early
    # if the artifact already exists. Lets us pick up a broken run without
    # losing the 50+ min of prep work.
    t0 = time.time()
    src_clean = work_dir / "source_clean.wav"
    src_raw = work_dir / "source.wav"
    if src_clean.exists():
        log(f"resume: source already denoised at {src_clean.name}")
        src = src_clean
    elif src_raw.exists() and not args.denoise:
        log(f"resume: source already downloaded at {src_raw.name}")
        src = src_raw
    else:
        src = stage_download(args, work_dir)
        src = stage_trim(src, work_dir, args)
        if args.denoise:
            src = stage_denoise(src, work_dir)

    sliced_dir = work_dir / "sliced"
    if sliced_dir.exists() and len(list(sliced_dir.glob("*.wav"))) >= 50:
        log(f"resume: {len(list(sliced_dir.glob('*.wav')))} sliced clips already on disk")
    else:
        sliced_dir = stage_slice(src, work_dir)

    list_file = work_dir / "asr" / "sliced.list"
    if list_file.exists():
        log(f"resume: ASR transcript already on disk at {list_file.name}")
    else:
        list_file = stage_asr(sliced_dir, work_dir)

    ref_path = work_dir / "ref.wav"
    if ref_path.exists():
        # Re-derive prompt_text from the .list (we don't persist it standalone)
        log("resume: reference clip already selected")
        ref_wav = ref_path
        prompt_text = ""
        with list_file.open(encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split("|")
                if len(parts) < 4: continue
                _, _, _, text = parts
                if text.strip(): prompt_text = text.strip(); break
    else:
        ref_wav, prompt_text = make_ref_clip(sliced_dir, list_file, work_dir,
                                              args.ref_start, args.ref_duration)

    opt_dir = REPO / "logs" / exp_name
    if (opt_dir / "2-name2text.txt").exists() and (opt_dir / "6-name2semantic.tsv").exists() \
            and (opt_dir / "7-sv_cn").exists() and len(list((opt_dir / "7-sv_cn").iterdir())) > 0:
        log(f"resume: format outputs already in {opt_dir.name}/")
    else:
        stage_format(list_file, sliced_dir, exp_name)

    # SoVITS training: if final epoch checkpoint is on disk, skip
    final_sovits = sorted((REPO / "SoVITS_weights_v2Pro").glob(f"{exp_name}_e{args.epochs_sovits}_*.pth"))
    if final_sovits:
        log(f"resume: SoVITS training already complete ({final_sovits[-1].name})")
        sovits_pth = final_sovits[-1]
    else:
        sovits_pth = stage_train_sovits(exp_name, args.epochs_sovits)

    # GPT training: same
    final_gpt = sorted((REPO / "GPT_weights_v2Pro").glob(f"{exp_name}-e{args.epochs_gpt}.ckpt"))
    if final_gpt:
        log(f"resume: GPT training already complete ({final_gpt[-1].name})")
        gpt_ckpt = final_gpt[-1]
    else:
        gpt_ckpt = stage_train_gpt(exp_name, args.epochs_gpt)

    clone_id = stage_register(args.name, sovits_pth, gpt_ckpt, ref_wav, prompt_text)
    elapsed = int(time.time() - t0)
    emit("DONE", json.dumps({"clone_id": clone_id, "name": args.name, "elapsed_sec": elapsed}))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        log(traceback.format_exc())
        fail(str(e))
