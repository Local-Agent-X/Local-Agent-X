/**
 * Durable per-operation side-effect execution journal.
 *
 * Canonical turn rows cannot close the window between an external mutation and
 * commitTurn, and the existing dedup caches are process-local. This journal is
 * deliberately narrower: only mutation effects on canonical operations are
 * recorded, using the existing per-op directory and lock.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { opDir } from "../ops/event-log.js";
import { withOpLock } from "../ops/op-store.js";
import type { ToolEffect, ToolResult } from "../types.js";

export type SideEffectJournalPhase = "prepared" | "effect_returned" | "completed";

interface JournalEntry {
  version: 1;
  operationId: string;
  toolCallId: string;
  tool: string;
  effectFingerprint: string;
  effect: ToolEffect;
  state: "prepared" | "executing" | "ambiguous" | "completed";
  result?: ToolResult;
  createdAt: string;
  updatedAt: string;
  reconciliationReason?: string;
}

export type JournalDecision =
  | { kind: "untracked" }
  | { kind: "execute"; entry: JournalEntry }
  | { kind: "replay"; entry: JournalEntry; result: ToolResult }
  | { kind: "reconcile"; entry: JournalEntry; result: ToolResult };

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

export function sideEffectFingerprint(
  tool: string,
  args: Record<string, unknown>,
  effect: ToolEffect,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ tool, args: stable(args), effect: stable(effect) }))
    .digest("hex");
}

function journalDir(operationId: string): string {
  return join(opDir(operationId), "side-effects");
}

function journalPath(operationId: string, toolCallId: string, fingerprint: string): string {
  const key = createHash("sha256")
    .update(`${operationId}|${toolCallId}|${fingerprint}`)
    .digest("hex");
  return join(journalDir(operationId), `${key}.json`);
}

function readEntry(path: string): JournalEntry | null {
  if (!existsSync(path)) return null;
  const entry = JSON.parse(readFileSync(path, "utf-8")) as JournalEntry;
  if (entry.version !== 1 || !entry.operationId || !entry.toolCallId || !entry.effectFingerprint || !entry.state) {
    throw new Error(`invalid side-effect journal entry: ${path}`);
  }
  return entry;
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

function reconciliationResult(entry: JournalEntry): ToolResult {
  return {
    content:
      `Side effect outcome is ambiguous for ${entry.tool} (${entry.toolCallId}). ` +
      `Execution began before the runtime stopped, and this non-idempotent call cannot be replayed safely. ` +
      `Reconcile the external system explicitly, then submit a new call only if the effect is confirmed absent.`,
    isError: true,
    status: "blocked",
    metadata: {
      layer: "side-effect-journal",
      reconciliation_required: true,
      effect_fingerprint: entry.effectFingerprint,
    },
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
  const effectFingerprint = sideEffectFingerprint(tool, args, effect);
  const path = journalPath(operationId, toolCallId, effectFingerprint);
  return withOpLock(operationId, () => {
    const existing = readEntry(path);
    if (existing?.state === "completed" && existing.result) {
      return { kind: "replay", entry: existing, result: existing.result };
    }
    if (existing && (existing.state === "executing" || existing.state === "ambiguous") &&
        effect.class === "non-idempotent") {
      if (existing.state !== "ambiguous") {
        existing.state = "ambiguous";
        existing.reconciliationReason = "runtime stopped after execution began without a durable result";
        existing.updatedAt = new Date().toISOString();
        writeEntry(path, existing);
      }
      return { kind: "reconcile", entry: existing, result: reconciliationResult(existing) };
    }
    if (existing) return { kind: "execute", entry: existing };
    const now = new Date().toISOString();
    const entry: JournalEntry = {
      version: 1,
      operationId,
      toolCallId,
      tool,
      effectFingerprint,
      effect,
      state: "prepared",
      createdAt: now,
      updatedAt: now,
    };
    writeEntry(path, entry);
    testHook?.("prepared", entry);
    return { kind: "execute", entry };
  });
}

export function markSideEffectExecuting(entry: JournalEntry): void {
  const path = journalPath(entry.operationId, entry.toolCallId, entry.effectFingerprint);
  withOpLock(entry.operationId, () => {
    const current = readEntry(path) ?? entry;
    if (current.state === "completed" || current.state === "ambiguous") return;
    current.state = "executing";
    current.updatedAt = new Date().toISOString();
    writeEntry(path, current);
  });
}

export function noteSideEffectReturned(entry: JournalEntry): void {
  testHook?.("effect_returned", entry);
}

export function markSideEffectAmbiguous(entry: JournalEntry, reason: string): ToolResult {
  const path = journalPath(entry.operationId, entry.toolCallId, entry.effectFingerprint);
  return withOpLock(entry.operationId, () => {
    const current = readEntry(path) ?? entry;
    if (current.state !== "completed") {
      current.state = "ambiguous";
      current.reconciliationReason = reason;
      current.updatedAt = new Date().toISOString();
      writeEntry(path, current);
    }
    return current.result ?? reconciliationResult(current);
  });
}

export function completeSideEffect(entry: JournalEntry, result: ToolResult): void {
  const path = journalPath(entry.operationId, entry.toolCallId, entry.effectFingerprint);
  withOpLock(entry.operationId, () => {
    const current = readEntry(path) ?? entry;
    if (current.state === "ambiguous") return;
    current.state = "completed";
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
