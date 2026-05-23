"""Training stages: SoVITS fine-tune, GPT fine-tune, register to LAX."""
from __future__ import annotations

import json
from pathlib import Path

from .constants import PYTHON, REPO, SOVITS_SIDECAR
from .protocol import fail, run, stage


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
