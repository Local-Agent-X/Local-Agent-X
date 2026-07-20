import { ALL_STEPS } from "./contract.mjs";

const STEP_REQUIRED = new Map(ALL_STEPS.map((step) => [step.id, step.required]));

export function cleanLines(raw) {
  const output = [];
  for (const physical of (raw || "").replace(/\r\n/g, "\n").split("\n")) {
    const frame = physical.includes("\r") ? physical.slice(physical.lastIndexOf("\r") + 1) : physical;
    if (frame.trim()) output.push(frame);
  }
  return output;
}

export function parsePercent(line) {
  const matches = line.match(/(\d{1,3})\s*%/g);
  if (!matches) return null;
  const percent = Number.parseInt(matches[matches.length - 1], 10);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

export function createReporter({ ipcMode = false, stdout = process.stdout, consoleImpl = console, exit = process.exit } = {}) {
  let currentStepId = null;
  const degraded = [];
  const ipc = (event) => {
    if (!ipcMode) return;
    try { stdout.write(`${JSON.stringify(event)}\n`); } catch {}
  };
  const step = (id, detail) => {
    if (currentStepId && currentStepId !== id) ipc({ type: "step", id: currentStepId, state: "done" });
    currentStepId = id;
    ipc({ type: "step", id, state: "running", detail: detail || null });
  };
  const stepDone = (id) => {
    ipc({ type: "step", id, state: "done" });
    if (currentStepId === id) currentStepId = null;
  };
  const emitLog = (level, prefix, method, message) => {
    if (!ipcMode) consoleImpl[method](`${prefix} ${message}`);
    ipc({ type: "log", level, id: currentStepId, line: message });
  };
  const log = (message) => emitLog("info", "[install]", "log", message);
  const ok = (message) => emitLog("ok", "[ok]", "log", message);
  const warn = (message) => emitLog("warn", "[warn]", "warn", message);
  const fail = (message) => {
    const required = currentStepId ? STEP_REQUIRED.get(currentStepId) !== false : true;
    if (!required) {
      warn(`${message} — continuing without it; the app will run with this feature unavailable.`);
      degraded.push({ step: currentStepId, message });
      ipc({ type: "step", id: currentStepId, state: "done" });
      currentStepId = null;
      return;
    }
    if (!ipcMode) consoleImpl.error(`[error] ${message}`);
    ipc({ type: "log", level: "error", id: currentStepId, line: message });
    if (currentStepId) ipc({ type: "step", id: currentStepId, state: "error", message });
    ipc({ type: "fatal", message });
    exit(1);
  };
  return { ipcMode, ipc, step, stepDone, log, ok, warn, fail, degraded, currentStep: () => currentStepId };
}
