"""Dataset prep stages: ASR transcription, feature extraction, reference clip."""
from __future__ import annotations

import shutil
from pathlib import Path

from .constants import PYTHON, REPO
from .protocol import fail, log, run, stage


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
