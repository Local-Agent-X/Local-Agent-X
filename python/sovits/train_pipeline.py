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

import os
import sys

# Allow running both as a script (`python python/sovits/train_pipeline.py`,
# used by the bridge subprocess launcher) and as a package
# (`python -m sovits.train_pipeline`). In script mode there is no parent
# package, so relative imports fail; resolve by adding the package's parent
# dir to sys.path and using absolute imports below.
if __package__ in (None, ""):
    _pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if _pkg_parent not in sys.path:
        sys.path.insert(0, _pkg_parent)

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
import uuid  # noqa: E402

from sovits._train.audio_stages import (  # noqa: E402
    stage_denoise,
    stage_download,
    stage_slice,
    stage_trim,
)
from sovits._train.constants import REPO, TRAINING_ROOT  # noqa: E402
from sovits._train.dataset_stages import (  # noqa: E402
    make_ref_clip,
    stage_asr,
    stage_format,
)
from sovits._train.protocol import emit, fail, log, set_log_file  # noqa: E402
from sovits._train.training_stages import (  # noqa: E402
    stage_register,
    stage_train_gpt,
    stage_train_sovits,
)


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
    log_path = work_dir / "_pipeline.log"
    try:
        # Append-only — preserves any earlier resume's log entries.
        log_path.touch(exist_ok=True)
        set_log_file(log_path)
    except Exception:
        set_log_file(None)

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
