/** Durable exactly-once guard for mutation effects inside canonical ops. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { opDir } from "../ops/event-log.js";
import type { ToolEffect, ToolEffectClass, ToolResult, ToolResultStatus } from "../types.js";

export type SideEffectJournalPhase = "prepared" | "effect_returned" | "completed";

interface ExecutionClaim {
  id: string;
  pid: number;
  runtimeId: string;
  claimedAt: string;
}

interface JournalEntry {
  version: 2;
  operationId: string;
  toolCallId: string;
  tool: string;
  effectFingerprint: string;
  effect: ToolEffect;
  state: "prepared" | "executing" | "ambiguous" | "completed";
  claim?: ExecutionClaim;
  result?: ToolResult;
  createdAt: string;
  updatedAt: string;
  reconciliationReason?: string;
}

export type JournalDecision =
  | { kind: "untracked" }
  | { kind: "execute"; entry: JournalEntry }
  | { kind: "replay"; entry: JournalEntry; result: ToolResult }
  | { kind: "blocked"; result: ToolResult };

const RUNTIME_ID = randomUUID();
const EFFECT_CLASSES: ReadonlySet<ToolEffectClass> = new Set([
  "read-only", "idempotent-mutation", "keyed-mutation", "non-idempotent",
]);
const RESULT_STATUSES: ReadonlySet<ToolResultStatus> = new Set([
  "ok", "error", "blocked", "declined", "timeout", "running",
]);
const STATES = new Set(["prepared", "executing", "ambiguous", "completed"]);
let testHook: ((phase: SideEffectJournalPhase, entry: Readonly<JournalEntry>) => void) | undefined;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key !== "_onProgress") out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sideEffectFingerprint(tool: string, args: Record<string, unknown>, effect: ToolEffect): string {
  return createHash("sha256")
    .update(JSON.stringify({ tool, args: stable(args), effect: stable(effect) }))
    .digest("hex");
}

function journalPath(operationId: string, toolCallId: string): string {
  const callIdentity = createHash("sha256").update(`${operationId}|${toolCallId}`).digest("hex");
  return join(opDir(operationId), "side-effects", `${callIdentity}.json`);
}

function withJournalLock<T>(operationId: string, fn: () => T): T {
  const dir = join(opDir(operationId), "side-effects");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dir, ".journal-lock.sqlite"), { timeout: 5_000 });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* original failure wins */ }
      throw error;
    }
  } finally {
    db.close();
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validEffect(value: unknown): value is ToolEffect {
  if (!value || typeof value !== "object") return false;
  const effect = value as Record<string, unknown>;
  if (!EFFECT_CLASSES.has(effect.class as ToolEffectClass)) return false;
  if (effect.class === "keyed-mutation") return typeof effect.operationKey === "string" && effect.operationKey.trim().length > 0;
  return effect.operationKey === undefined;
}

function validResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.content !== "string") return false;
  if (result.isError !== undefined && typeof result.isError !== "boolean") return false;
  if (result.status !== undefined && !RESULT_STATUSES.has(result.status as ToolResultStatus)) return false;
  if (result.metadata !== undefined && (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata))) return false;
  return true;
}

function validClaim(value: unknown): value is ExecutionClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.id === "string" && claim.id.length > 0 &&
    Number.isInteger(claim.pid) && (claim.pid as number) > 0 &&
    typeof claim.runtimeId === "string" && claim.runtimeId.length > 0 &&
    validDate(claim.claimedAt);
}

function validateEntry(value: unknown): JournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("entry is not an object");
  const entry = value as Record<string, unknown>;
  if (entry.version !== 2) throw new Error("unsupported journal version");
  for (const key of ["operationId", "toolCallId", "tool"] as const) {
    if (typeof entry[key] !== "string" || entry[key].length === 0) throw new Error(`invalid ${key}`);
  }
  if (typeof entry.effectFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.effectFingerprint)) {
    throw new Error("invalid effect fingerprint");
  }
  if (!validEffect(entry.effect)) throw new Error("invalid effect metadata");
  if (!STATES.has(entry.state as string)) throw new Error("invalid journal state");
  if (!validDate(entry.createdAt) || !validDate(entry.updatedAt)) throw new Error("invalid timestamps");
  const active = entry.state === "prepared" || entry.state === "executing";
  if (active !== validClaim(entry.claim)) throw new Error("claim/state inconsistency");
  if (entry.state === "completed" ? !validResult(entry.result) : entry.result !== undefined) {
    throw new Error("result/state inconsistency");
  }
  if (entry.state === "ambiguous") {
    if (typeof entry.reconciliationReason !== "string" || entry.reconciliationReason.length === 0) {
      throw new Error("ambiguous entry lacks reconciliation reason");
    }
  } else if (entry.reconciliationReason !== undefined) {
    throw new Error("reconciliation reason on non-ambiguous entry");
  }
  return entry as unknown as JournalEntry;
}

function readEntry(path: string): JournalEntry | null {
  if (!existsSync(path)) return null;
  return validateEntry(JSON.parse(readFileSync(path, "utf-8")) as unknown);
}

function writeEntry(path: string, entry: JournalEntry): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(entry, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function newClaim(): ExecutionClaim {
  return { id: randomUUID(), pid: process.pid, runtimeId: RUNTIME_ID, claimedAt: new Date().toISOString() };
}

function claimOwnerAlive(claim: ExecutionClaim): boolean {
  try { process.kill(claim.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function blockedResult(message: string, metadata: Record<string, unknown>): ToolResult {
  return {
    content: message,
    isError: true,
    status: "blocked",
    metadata: { layer: "side-effect-journal", reconciliation_required: true, ...metadata },
  };
}

function ambiguousResult(entry: JournalEntry): ToolResult {
  return blockedResult(
    `Side effect outcome is ambiguous for ${entry.tool} (${entry.toolCallId}). ` +
      `Execution began before the runtime stopped, and this non-idempotent call cannot be replayed safely. ` +
      `Reconcile the external system explicitly, then submit a new call only if the effect is confirmed absent.`,
    { effect_fingerprint: entry.effectFingerprint },
  );
}

function integrityFailure(reason: string): JournalDecision {
  return {
    kind: "blocked",
    result: blockedResult(
      `Side-effect journal integrity check failed (${reason}). Execution was blocked to prevent a duplicate mutation. ` +
        `Repair or explicitly reconcile the operation journal before retrying.`,
      { journal_integrity_failure: true },
    ),
  };
}

export function prepareSideEffect(
  operationId: string | undefined,
  toolCallId: string,
  tool: string,
  args: Record<string, unknown>,
  effect: ToolEffect,
): JournalDecision {
  if (!operationId || effect.class === "read-only") return { kind: "untracked" };
  const fingerprint = sideEffectFingerprint(tool, args, effect);
  const path = journalPath(operationId, toolCallId);
  return withJournalLock(operationId, () => {
    let existing: JournalEntry | null;
    try { existing = readEntry(path); }
    catch (error) { return integrityFailure((error as Error).message); }
    if (existing) {
      if (existing.operationId !== operationId || existing.toolCallId !== toolCallId || existing.tool !== tool) {
        return integrityFailure("persisted call identity does not match dispatch identity");
      }
      if (existing.effectFingerprint !== fingerprint || JSON.stringify(existing.effect) !== JSON.stringify(effect)) {
        return integrityFailure("tool call was reused with different arguments or effect metadata");
      }
      if (existing.state === "completed") return { kind: "replay", entry: existing, result: existing.result! };
      if (existing.state === "ambiguous") return { kind: "blocked", result: ambiguousResult(existing) };
      if (existing.claim && claimOwnerAlive(existing.claim)) {
        return {
          kind: "blocked",
          result: blockedResult(
            `Side effect ${tool} (${toolCallId}) is already claimed by a live execution. ` +
              `The concurrent duplicate was blocked; wait for the recorded result before retrying.`,
            { execution_in_progress: true, effect_fingerprint: fingerprint },
          ),
        };
      }
      if (existing.state === "executing" && effect.class === "non-idempotent") {
        existing.state = "ambiguous";
        delete existing.claim;
        existing.reconciliationReason = "claim owner stopped after execution began without a durable result";
        existing.updatedAt = new Date().toISOString();
        writeEntry(path, existing);
        return { kind: "blocked", result: ambiguousResult(existing) };
      }
      existing.claim = newClaim();
      existing.updatedAt = new Date().toISOString();
      writeEntry(path, existing);
      testHook?.("prepared", existing);
      return { kind: "execute", entry: existing };
    }
    const now = new Date().toISOString();
    const entry: JournalEntry = {
      version: 2,
      operationId,
      toolCallId,
      tool,
      effectFingerprint: fingerprint,
      effect,
      state: "prepared",
      claim: newClaim(),
      createdAt: now,
      updatedAt: now,
    };
    writeEntry(path, entry);
    testHook?.("prepared", entry);
    return { kind: "execute", entry };
  });
}

function currentClaimedEntry(entry: JournalEntry): { path: string; current: JournalEntry } {
  const path = journalPath(entry.operationId, entry.toolCallId);
  const current = readEntry(path);
  if (!current || !entry.claim || current.claim?.id !== entry.claim.id) throw new Error("side-effect journal claim lost");
  if (current.effectFingerprint !== entry.effectFingerprint) throw new Error("side-effect journal fingerprint changed");
  return { path, current };
}

export function markSideEffectExecuting(entry: JournalEntry): void {
  withJournalLock(entry.operationId, () => {
    const { path, current } = currentClaimedEntry(entry);
    if (current.state !== "prepared" && current.state !== "executing") throw new Error("side-effect claim is not executable");
    current.state = "executing";
    current.updatedAt = new Date().toISOString();
    writeEntry(path, current);
  });
}

export function noteSideEffectReturned(entry: JournalEntry): void {
  testHook?.("effect_returned", entry);
}

export function markSideEffectAmbiguous(entry: JournalEntry, reason: string): ToolResult {
  return withJournalLock(entry.operationId, () => {
    const { path, current } = currentClaimedEntry(entry);
    current.state = "ambiguous";
    delete current.claim;
    current.reconciliationReason = reason || "execution outcome is unknown";
    current.updatedAt = new Date().toISOString();
    writeEntry(path, current);
    return ambiguousResult(current);
  });
}

export function completeSideEffect(entry: JournalEntry, result: ToolResult): void {
  if (!validResult(result)) throw new Error("refusing to persist invalid side-effect result");
  withJournalLock(entry.operationId, () => {
    const { path, current } = currentClaimedEntry(entry);
    current.state = "completed";
    delete current.claim;
    current.result = result;
    current.updatedAt = new Date().toISOString();
    writeEntry(path, current);
    testHook?.("completed", current);
  });
}

/** Test-only crash injection at durable journal boundaries. */
export function _setSideEffectJournalHookForTests(
  hook?: (phase: SideEffectJournalPhase, entry: Readonly<JournalEntry>) => void,
): void {
  testHook = hook;
}
