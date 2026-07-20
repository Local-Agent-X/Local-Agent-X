import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installerContract, stepIntent } from "./contract.mjs";

const FILE = "install-checkpoint.json";

export function writeDurableJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  const handle = openSync(temporary, "r+");
  try { fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch {}
}

function validRecord(value) {
  if (!value || value.version !== 1 || !value.contract || !Array.isArray(value.completed)) return false;
  if (!value.completed.every((item) => item && typeof item.id === "string" && typeof item.intent === "string")) return false;
  if (value.inFlight !== null && (!value.inFlight || typeof value.inFlight.id !== "string" || typeof value.inFlight.intent !== "string")) return false;
  return Array.isArray(value.degraded) && value.degraded.every((item) => typeof item?.step === "string" && typeof item?.message === "string");
}

function readRecord(path) {
  if (!existsSync(path)) return { kind: "empty", value: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return validRecord(value) ? { kind: "valid", value } : { kind: "corrupt", value: null };
  } catch {
    return { kind: "corrupt", value: null };
  }
}

export function createInstallCheckpoint(context, { verifyStep = context.verifyInstallStep } = {}) {
  const directory = context.dataDirectory || join(homedir(), ".lax");
  const path = join(directory, FILE);
  const contract = installerContract(context.platform || process.platform, context.selections || {
    ollamaRuntime: Boolean(context.wantOllama),
    ollamaMemoryModel: Boolean(context.wantOllamaMemoryModel),
  });
  const loaded = readRecord(path);
  let record = loaded.value || { version: 1, contract, completed: [], inFlight: null, degraded: [], outputs: {} };

  const verify = (id, evidence) => {
    if (!verifyStep) return "ambiguous";
    const result = verifyStep(id, context, evidence);
    return result === true || result === "present" ? "present"
      : result === false || result === "absent" ? "absent" : "ambiguous";
  };
  const save = () => writeDurableJson(path, record);
  const resetForContract = () => { record.contract = contract; };
  const clearStepState = (id, reporter, { output = false } = {}) => {
    reporter.clearDegraded?.(id);
    record.degraded = reporter.degraded;
    if (output && record.outputs) delete record.outputs[id];
  };

  return {
    path,
    restore(reporter) {
      if (loaded.kind === "corrupt") return { blocked: "Installer checkpoint is corrupt or truncated. Restore or remove it only after verifying prior installer side effects." };
      reporter.restoreDegraded?.(record.degraded);
      if (record.inFlight) {
        const state = verify(record.inFlight.id, { inFlight: true, startedAt: record.inFlight.startedAt });
        if (state === "ambiguous") {
          return { blocked: `Cannot safely resume after interrupted installer step '${record.inFlight.id}'. Its side effect is ambiguous; completed earlier steps remain saved.` };
        }
        if (state === "present") {
          clearStepState(record.inFlight.id, reporter, {
            output: record.inFlight.intent !== stepIntent(contract, record.inFlight.id),
          });
          record.completed = record.completed.filter((item) => item.id !== record.inFlight.id);
          record.completed.push({ id: record.inFlight.id, intent: stepIntent(contract, record.inFlight.id) });
        }
        record.inFlight = null;
        resetForContract();
        save();
      }
      return { blocked: null };
    },
    begin(id, reporter) {
      const intent = stepIntent(contract, id);
      const completed = record.completed.find((item) => item.id === id);
      const prior = record.inFlight?.id === id ? record.inFlight : completed;
      if (prior) {
        const state = verify(id, { inFlight: false, intentMatches: prior.intent === intent });
        if (state === "present") {
          clearStepState(id, reporter, { output: prior.intent !== intent });
          record.completed = record.completed.filter((item) => item.id !== id);
          record.completed.push({ id, intent });
          resetForContract();
          save();
          return { action: "skip", output: record.outputs?.[id] };
        }
        if (state === "ambiguous") return { action: "block", message: `Cannot safely resume installer step '${id}': its prior side effect is ambiguous. Resolve the step state and retry; completed earlier steps remain saved.` };
        record.completed = record.completed.filter((item) => item.id !== id);
        clearStepState(id, reporter, { output: true });
      } else if (record.inFlight) {
        return { action: "block", message: `Cannot safely resume after interrupted installer step '${record.inFlight.id}'. Its state must be verified before continuing.` };
      }
      resetForContract();
      record.degraded = reporter.degraded;
      record.inFlight = { id, intent, startedAt: new Date().toISOString() };
      save();
      return { action: "run" };
    },
    complete(id, reporter, output) {
      const intent = stepIntent(contract, id);
      record.completed = record.completed.filter((item) => item.id !== id);
      record.completed.push({ id, intent });
      record.inFlight = null;
      record.degraded = reporter.degraded;
      record.outputs ||= {};
      if (output !== undefined) record.outputs[id] = output;
      save();
    },
    finish() { rmSync(path, { force: true }); },
  };
}

export function installCheckpointPath(dataDirectory = join(homedir(), ".lax")) {
  return join(dataDirectory, FILE);
}

export function resetInstallCheckpoint(dataDirectory = join(homedir(), ".lax")) {
  const path = installCheckpointPath(dataDirectory);
  rmSync(path, { force: true });
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch {}
}
