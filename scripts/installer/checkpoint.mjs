import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { stepIntent } from "./contract.mjs";
import { mutateInstallerDataRoot } from "./data-root.mjs";
import {
  activeCheckpointPath, checkpointContract, defaultStepState, INSTALL_JOURNAL_VERSION,
  INSTALL_TRANSACTION_RELATIVE, installTransactionPath, legacyCheckpointPath,
  LEGACY_CHECKPOINT_FILE, validLegacyCheckpoint, validStepState,
} from "./install-journal.mjs";

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function directoryIdentity(path) {
  const info = lstatSync(path);
  const real = realpathSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(real, path)) {
    throw new Error(`Durable JSON parent is linked or not a directory: ${path}`);
  }
  return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs, real };
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs && samePath(left.real, right.real);
}

function assertSafeFile(path, expected) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !samePath(realpathSync(path), path)) {
    throw new Error(`Durable JSON path is linked or not a regular file: ${path}`);
  }
  if (expected && (info.dev !== expected.dev || info.ino !== expected.ino)) {
    throw new Error(`Durable JSON temporary file identity changed: ${path}`);
  }
  return info;
}

export function readDurableJson(path, fallback = {}, options = {}) {
  if (!existsSync(path)) return fallback;
  const parent = dirname(path);
  const parentBefore = directoryIdentity(parent);
  const handle = openSync(path, "r");
  try {
    const opened = fstatSync(handle);
    options.fault?.("before-read", { path, parent });
    assertSafeFile(path, opened);
    if (!sameDirectory(parentBefore, directoryIdentity(parent))) {
      throw new Error(`Durable JSON parent identity changed: ${parent}`);
    }
    const raw = readFileSync(handle, "utf-8");
    assertSafeFile(path, opened);
    if (!sameDirectory(parentBefore, directoryIdentity(parent))) {
      throw new Error(`Durable JSON parent identity changed: ${parent}`);
    }
    try { return JSON.parse(raw); } catch { return fallback; }
  } finally {
    closeSync(handle);
  }
}

export function writeDurableJson(path, value, options = {}) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const parentBefore = directoryIdentity(parent);
  if (existsSync(path)) assertSafeFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  const opened = fstatSync(handle);
  if (!opened.isFile() || opened.nlink !== 1) {
    closeSync(handle);
    try { rmSync(temporary, { force: true }); } catch {}
    throw new Error(`Durable JSON temporary file is not private: ${temporary}`);
  }
  let writeError;
  try {
    writeFileSync(handle, JSON.stringify(value, null, 2), { encoding: "utf-8" });
    fsyncSync(handle);
  } catch (error) {
    writeError = error;
  } finally {
    closeSync(handle);
  }
  if (writeError) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw writeError;
  }
  try {
    options.fault?.("before-publication", { temporary, parent });
    assertSafeFile(temporary, opened);
    if (!sameDirectory(parentBefore, directoryIdentity(parent))) {
      throw new Error(`Durable JSON parent identity changed: ${parent}`);
    }
    if (existsSync(path)) assertSafeFile(path);
    renameSync(temporary, path);
    if (!sameDirectory(parentBefore, directoryIdentity(parent))) {
      throw new Error(`Durable JSON parent identity changed: ${parent}`);
    }
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch {}
}

function readRecord(path) {
  if (!existsSync(path)) return { kind: "empty", value: null };
  try {
    const invalid = {};
    const value = readDurableJson(path, invalid);
    return validLegacyCheckpoint(value) ? { kind: "valid", value } : { kind: "corrupt", value: null };
  } catch {
    return { kind: "corrupt", value: null };
  }
}

export function loadLegacyCheckpointState(context) {
  return readRecord(legacyCheckpointPath(context.dataDirectory));
}

export function removeLegacyCheckpoint(context) {
  const path = legacyCheckpointPath(context.dataDirectory);
  mutateInstallerDataRoot(context, [LEGACY_CHECKPOINT_FILE], () => rmSync(path, { force: true }));
}

export function createInstallCheckpoint(context, { verifyStep = context.verifyInstallStep } = {}) {
  const directory = context.dataDirectory;
  const legacyPath = legacyCheckpointPath(directory);
  const transactionPath = installTransactionPath(directory);
  const contract = checkpointContract(context);
  let unified = existsSync(transactionPath);
  let loaded;
  if (unified) {
    try {
      const journal = readDurableJson(transactionPath, null);
      loaded = journal?.version === INSTALL_JOURNAL_VERSION && validStepState(journal.steps)
        ? { kind: "valid", value: journal.steps } : { kind: "corrupt", value: null };
    } catch { loaded = { kind: "corrupt", value: null }; }
  } else loaded = readRecord(legacyPath);
  let record = loaded.value || defaultStepState(context);

  const verify = (id, evidence) => {
    if (!verifyStep) return "ambiguous";
    const result = verifyStep(id, context, evidence);
    return result === true || result === "present" ? "present"
      : result === false || result === "absent" ? "absent" : "ambiguous";
  };
  const save = () => {
    if (!unified) {
      const legacy = { version: 1, ...record };
      mutateInstallerDataRoot(context, [LEGACY_CHECKPOINT_FILE], () => writeDurableJson(legacyPath, legacy));
      return;
    }
    mutateInstallerDataRoot(context, [INSTALL_TRANSACTION_RELATIVE], () => {
      const journal = readDurableJson(transactionPath, null);
      if (journal?.version !== INSTALL_JOURNAL_VERSION || !validStepState(journal.steps)) {
        throw new Error("Installer transaction journal is corrupt or truncated.");
      }
      journal.steps = record;
      writeDurableJson(transactionPath, journal);
    });
  };
  const resetForContract = () => { record.contract = contract; };
  const clearStepState = (id, reporter, { output = false } = {}) => {
    reporter.clearDegraded?.(id);
    record.degraded = reporter.degraded;
    if (output && record.outputs) delete record.outputs[id];
  };

  return {
    get path() { return unified ? transactionPath : legacyPath; },
    snapshot() { return structuredClone(record); },
    bindUnified() {
      const journal = readDurableJson(transactionPath, null);
      if (journal?.version !== INSTALL_JOURNAL_VERSION) throw new Error("Installer transaction journal is missing after backup preparation.");
      journal.steps = record;
      mutateInstallerDataRoot(context, [INSTALL_TRANSACTION_RELATIVE], () => writeDurableJson(transactionPath, journal));
      unified = true;
      removeLegacyCheckpoint(context);
    },
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
    finish() { removeLegacyCheckpoint(context); },
  };
}

export function installCheckpointPath(dataDirectory) {
  return activeCheckpointPath(dataDirectory);
}

export function resetInstallCheckpoint(dataDirectory, context) {
  const path = legacyCheckpointPath(dataDirectory);
  const remove = () => {
    rmSync(path, { force: true });
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {}
  };
  if (context) mutateInstallerDataRoot(context, [LEGACY_CHECKPOINT_FILE], remove);
  else remove();
}
