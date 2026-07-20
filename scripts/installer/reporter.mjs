import { ALL_STEPS } from "./contract.mjs";

const STEP_REQUIRED = new Map(ALL_STEPS.map((step) => [step.id, step.required]));
const STEP_ORDER = new Map(ALL_STEPS.map((step, index) => [step.id, index]));

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
  let stepLifecycle = null;
  let requiredFailure = null;
  const resumedOutputs = new Map();
  const degraded = [];
  const sortDegraded = () => degraded.sort((left, right) =>
    (STEP_ORDER.get(left.step) ?? Number.MAX_SAFE_INTEGER) - (STEP_ORDER.get(right.step) ?? Number.MAX_SAFE_INTEGER));
  const ipc = (event) => {
    if (!ipcMode) return;
    try { stdout.write(`${JSON.stringify(event)}\n`); } catch {}
  };
  let api;
  const abort = (message) => {
    if (!ipcMode) consoleImpl.error(`[error] ${message}`);
    ipc({ type: "log", level: "error", id: currentStepId, line: message });
    if (currentStepId) ipc({ type: "step", id: currentStepId, state: "error", message });
    ipc({ type: "fatal", message, retryable: true });
    exit(1);
  };
  const step = (id, detail) => {
    if (currentStepId && currentStepId !== id) ipc({ type: "step", id: currentStepId, state: "done" });
    currentStepId = id;
    ipc({ type: "step", id, state: "running", detail: detail || null });
    const decision = stepLifecycle?.begin(id, api) || { action: "run" };
    if (decision.action === "block") { abort(decision.message); return false; }
    if (decision.action === "skip") {
      resumedOutputs.set(id, decision.output);
      ipc({ type: "step", id, state: "done" });
      currentStepId = null;
      return false;
    }
    return true;
  };
  const stepDone = (id, output) => {
    stepLifecycle?.complete(id, api, output);
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
      sortDegraded();
      stepDone(currentStepId);
      return;
    }
    let rollback = null;
    try { rollback = requiredFailure?.(message) || null; }
    catch (error) {
      message = `${message} Rollback could not be verified: ${error.message}`;
    }
    if (!ipcMode) consoleImpl.error(`[error] ${message}`);
    ipc({ type: "log", level: "error", id: currentStepId, line: message });
    if (currentStepId) ipc({ type: "step", id: currentStepId, state: "error", message });
    const fatal = { type: "fatal", message };
    if (rollback && rollback.outcome !== "disabled") fatal.rollback = rollback;
    ipc(fatal);
    exit(1);
  };
  api = {
    ipcMode, ipc, step, stepDone, log, ok, warn, fail, abort, degraded,
    currentStep: () => currentStepId,
    attachStepLifecycle: (lifecycle) => { stepLifecycle = lifecycle; },
    attachRequiredFailure: (handler) => { requiredFailure = handler; },
    resumedStepResult: (id) => resumedOutputs.get(id),
    restoreDegraded: (items) => { degraded.splice(0, degraded.length, ...items); sortDegraded(); },
    clearDegraded: (id) => {
      for (let index = degraded.length - 1; index >= 0; index -= 1) {
        if (degraded[index].step === id) degraded.splice(index, 1);
      }
    },
  };
  return api;
}
