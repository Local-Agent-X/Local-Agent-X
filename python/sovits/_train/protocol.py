"""Stdout protocol + subprocess runner for the SoVITS training pipeline.

Each emitted line is one of:
    STAGE: <id>|<label>|<pct>|<eta_sec>
    LOG:   <freeform message>
    DONE:  {clone_id, name}
    ERROR: <message>
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# A second sink for emit() lines so a user who closes the modal can still
# tail the live log later. Set once we know work_dir (in main()).
_LOG_FILE: "Path | None" = None


def set_log_file(path: "Path | None") -> None:
    global _LOG_FILE
    _LOG_FILE = path


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
