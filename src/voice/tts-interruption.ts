// TTS playback interruption. The playback layer registers each spawned
// process; interruptSpeech() kills the current one when new speech is
// detected mid-playback. wasTTSInterrupted() lets downstream callers
// distinguish "user interrupted" from "playback finished normally."

import type { spawn } from "node:child_process";

type ChildProc = ReturnType<typeof spawn>;

let _currentTTSProcess: ChildProc | null = null;
let _ttsInterrupted = false;

export function registerTTSProcess(proc: ChildProc): void {
  _currentTTSProcess = proc;
  _ttsInterrupted = false;
  proc.on("close", () => {
    if (_currentTTSProcess === proc) _currentTTSProcess = null;
  });
}

export function interruptSpeech(): boolean {
  if (!_currentTTSProcess) return false;
  _ttsInterrupted = true;
  try {
    _currentTTSProcess.kill();
    _currentTTSProcess = null;
    return true;
  } catch {
    return false;
  }
}

export function wasTTSInterrupted(): boolean {
  return _ttsInterrupted;
}
