import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { appDir, statePath } from "./paths.js";
import type { RateLimiter } from "./rate-limiter.js";
import { type AppState, MAX_ACTIONS_QUEUED, MAX_STATE_SIZE_BYTES, type QueuedAction } from "./types.js";
import { createLogger } from "../logger.js";
import type { AuditEntry } from "./types.js";

const logger = createLogger("app-runtime");

type AuditWriter = (appId: string, actor: string, action: string, details?: Record<string, unknown>) => AuditEntry;

export function readState(id: string): AppState | null {
  const p = statePath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); }
  catch (e) {
    logger.warn(`failed to parse app state ${id}: ${(e as Error).message}`);
    return null;
  }
}

export function writeState(id: string, state: AppState): void {
  const dir = appDir(id);
  if (!existsSync(dir)) return;

  const serialized = JSON.stringify(state, null, 2);
  if (serialized.length > MAX_STATE_SIZE_BYTES) return;

  writeFileSync(statePath(id), serialized, "utf-8");
}

export function updateComponentValues(
  id: string,
  values: Record<string, unknown>,
  actor: string,
  limiter: RateLimiter,
  writeAudit: AuditWriter,
): { state?: AppState; error?: string } {
  if (!limiter.check(`state:${id}`)) {
    return { error: "Rate limit exceeded for state updates" };
  }

  const state = readState(id);
  if (!state) return { error: "App not found" };

  state.componentValues = { ...state.componentValues, ...values };
  state.metadata.lastAgentUpdate = Date.now();
  state.metadata.version++;
  writeState(id, state);

  writeAudit(id, actor, "state:update", {
    components: Object.keys(values),
    version: state.metadata.version,
  });

  return { state };
}

export function queueAction(
  id: string,
  action: string,
  target: string | undefined,
  value: unknown,
  actor: string,
  writeAudit: AuditWriter,
): { action?: QueuedAction; error?: string } {
  const state = readState(id);
  if (!state) return { error: "App not found" };

  const queued: QueuedAction = {
    id: `act_${Date.now()}_${randomBytes(4).toString("hex")}`,
    action,
    target,
    value,
    timestamp: Date.now(),
    consumed: false,
  };
  state.actionQueue.push(queued);
  if (state.actionQueue.length > MAX_ACTIONS_QUEUED) state.actionQueue = state.actionQueue.slice(-MAX_ACTIONS_QUEUED);
  state.metadata.lastAgentUpdate = Date.now();
  writeState(id, state);

  writeAudit(id, actor, "action:queue", { action, target });

  return { action: queued };
}

export function consumeActions(id: string, actionIds: string[]): void {
  const state = readState(id);
  if (!state) return;
  const idSet = new Set(actionIds);
  for (const a of state.actionQueue) {
    if (idSet.has(a.id)) a.consumed = true;
  }
  writeState(id, state);
}

export function getPendingActions(id: string): QueuedAction[] {
  const state = readState(id);
  if (!state) return [];
  return state.actionQueue.filter(a => !a.consumed);
}
