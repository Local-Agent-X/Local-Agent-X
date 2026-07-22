import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installerContract } from "./contract.mjs";

export const INSTALL_JOURNAL_VERSION = 2;
export const LEGACY_CHECKPOINT_FILE = "install-checkpoint.json";
export const INSTALL_TRANSACTION_RELATIVE = join("install-rollback", "transaction.json");

export function legacyCheckpointPath(dataDirectory = join(homedir(), ".lax")) {
  return join(dataDirectory, LEGACY_CHECKPOINT_FILE);
}

export function installTransactionPath(dataDirectory = join(homedir(), ".lax")) {
  return join(dataDirectory, INSTALL_TRANSACTION_RELATIVE);
}

export function checkpointContract(context) {
  return installerContract(context.platform || process.platform, context.selections || {
    ollamaRuntime: Boolean(context.wantOllama),
    ollamaMemoryModel: Boolean(context.wantOllamaMemoryModel),
  });
}

export function defaultStepState(context) {
  return {
    contract: checkpointContract(context), completed: [], inFlight: null, degraded: [], outputs: {},
  };
}

export function validStepState(value) {
  if (!value || !value.contract || !Array.isArray(value.completed)) return false;
  if (!value.completed.every((item) => item && typeof item.id === "string" && typeof item.intent === "string")) return false;
  if (value.inFlight !== null && (!value.inFlight || typeof value.inFlight.id !== "string" || typeof value.inFlight.intent !== "string")) return false;
  if (!Array.isArray(value.degraded) || !value.degraded.every((item) => typeof item?.step === "string" && typeof item?.message === "string")) return false;
  return value.outputs === undefined || value.outputs && typeof value.outputs === "object" && !Array.isArray(value.outputs);
}

export function validLegacyCheckpoint(value) {
  return value?.version === 1 && validStepState(value);
}

export function stepStatesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function activeCheckpointPath(dataDirectory = join(homedir(), ".lax")) {
  const transaction = installTransactionPath(dataDirectory);
  return existsSync(transaction) ? transaction : legacyCheckpointPath(dataDirectory);
}
