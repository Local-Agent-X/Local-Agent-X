"""Shared paths and endpoints for the SoVITS training pipeline."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

REPO = Path(os.path.expanduser("~/.lax/sovits/repo"))
TRAINING_ROOT = Path(os.path.expanduser("~/.lax/sovits-training"))
PYTHON = sys.executable  # this script is launched via the GPTSoVits venv
FFMPEG = os.environ.get("LAX_FFMPEG") or shutil.which("ffmpeg")
SOVITS_API = os.environ.get("LAX_SOVITS_API_V2", "http://127.0.0.1:7011")
SOVITS_SIDECAR = os.environ.get("LAX_SOVITS_SIDECAR", "http://127.0.0.1:7012")
