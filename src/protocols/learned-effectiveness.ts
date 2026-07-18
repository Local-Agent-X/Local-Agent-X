import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { atomicWriteFileSync } from "../util/json-store.js";

export type LearnedOutcome = "clean" | "partial" | "aborted";
export type LearnedOutcomeStatus = "pending" | "committed";

export interface LearnedOutcomeInput {
  opId: string;
  sessionId: string;
  slug: string;
  versionId: string;
  candidateId: string;
  outcome: LearnedOutcome;
  timestamp: number;
}

export interface LearnedOutcomeReceipt extends LearnedOutcomeInput {
  schemaVersion: 1;
  status: LearnedOutcomeStatus;
}

export interface VersionEffectiveness {
  slug: string;
  versionId: string;
  candidateId: string | null;
  total: number;
  clean: number;
  partial: number;
  aborted: number;
  cleanRate: number;
  partialRate: number;
  abortedRate: number;
  qualityScore: number;
  distinctSessions: number;
  lastOutcomeAt: number | null;
}

export interface EffectivenessReconcileReport {
  committed: string[];
  retained: string[];
  quarantined: string[];
}

type OpSnapshot = { canonical?: { state?: string }; status?: string };
type WritePhase = "before-write";

const OUTCOMES = new Set<LearnedOutcome>(["clean", "partial", "aborted"]);
const STATUSES = new Set<LearnedOutcomeStatus>(["pending", "committed"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "completed"]);
const RECEIPT_KEYS = new Set([
  "schemaVersion", "status", "opId", "sessionId", "slug", "versionId",
  "candidateId", "outcome", "timestamp",
]);
const MISSING_OP_TTL_MS = 24 * 60 * 60 * 1000;
let writeHook: ((phase: WritePhase, receipt: Readonly<LearnedOutcomeReceipt>) => void) | undefined;

function terminalAcceptsOutcome(state: string, outcome: LearnedOutcome): boolean {
  if (state === "succeeded" || state === "completed") return outcome === "clean" || outcome === "partial";
  if (state === "failed") return outcome === "aborted";
  return false;
}

function ledgerDir(): string {
  return resolve(getRuntimeConfig().workspace, "protocols", "effectiveness");
}

function outcomesDir(): string {
  return join(ledgerDir(), "outcomes");
}

function identity(opId: string): string {
  return createHash("sha256").update(opId).digest("hex");
}

function receiptPath(opId: string): string {
  if (typeof opId !== "string" || opId.trim().length === 0) throw new Error("Invalid learned outcome opId");
  const dir = outcomesDir();
  rejectSymlink(dir);
  const path = join(dir, `${identity(opId)}.json`);
  const root = resolve(dir);
  const target = resolve(path);
  if (!target.startsWith(root + sep)) throw new Error("Learned outcome path escapes its ledger");
  return path;
}

function withLedgerLock<T>(fn: () => T): T {
  const dir = ledgerDir();
  rejectSymlink(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".ledger-lock");
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      atomicWriteFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, claimedAt: Date.now() }), { mode: 0o600 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (existsSync(lock)) rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      let ownerAlive = true;
      try {
        const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: unknown; claimedAt?: unknown };
        if (!Number.isInteger(owner.pid) || typeof owner.claimedAt !== "number") throw new Error("invalid lock owner");
        try { process.kill(owner.pid as number, 0); }
        catch (killError) { ownerAlive = (killError as NodeJS.ErrnoException).code !== "ESRCH"; }
        ownerAlive = ownerAlive && Date.now() - owner.claimedAt < 5 * 60_000;
      } catch {
        ownerAlive = Date.now() - statSync(lock).mtimeMs < 30_000;
      }
      if (ownerAlive) throw new Error("Learned effectiveness ledger is busy");
      rmSync(lock, { recursive: true, force: true });
    }
  }
  if (!acquired) throw new Error("Unable to acquire learned effectiveness ledger lock");
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function validateReceipt(value: unknown, path?: string): LearnedOutcomeReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt is not an object");
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key)) || Object.keys(receipt).length !== RECEIPT_KEYS.size) {
    throw new Error("receipt contains unknown or missing fields");
  }
  if (receipt.schemaVersion !== 1 || !STATUSES.has(receipt.status as LearnedOutcomeStatus)) throw new Error("invalid receipt version or status");
  for (const key of ["opId", "slug", "versionId", "candidateId"] as const) {
    if (typeof receipt[key] !== "string" || (receipt[key] as string).trim().length === 0) throw new Error(`invalid ${key}`);
  }
  if (typeof receipt.sessionId !== "string") throw new Error("invalid sessionId");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(receipt.slug as string)) throw new Error("invalid slug");
  if (!OUTCOMES.has(receipt.outcome as LearnedOutcome)) throw new Error("invalid outcome");
  if (typeof receipt.timestamp !== "number" || !Number.isFinite(receipt.timestamp) || receipt.timestamp <= 0) throw new Error("invalid timestamp");
  if (path && basename(path) !== `${identity(receipt.opId as string)}.json`) throw new Error("receipt filename does not match opId");
  return receipt as unknown as LearnedOutcomeReceipt;
}

function rejectSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${basename(path)}`);
}

function readReceipt(path: string): LearnedOutcomeReceipt | null {
  if (!existsSync(path)) return null;
  rejectSymlink(path);
  return validateReceipt(JSON.parse(readFileSync(path, "utf8")), path);
}

function writeReceipt(path: string, receipt: LearnedOutcomeReceipt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeHook?.("before-write", receipt);
  atomicWriteFileSync(path, JSON.stringify(receipt, null, 2), { mode: 0o600 });
}

function sameInput(receipt: LearnedOutcomeReceipt, input: LearnedOutcomeInput): boolean {
  return receipt.opId === input.opId
    && receipt.sessionId === input.sessionId
    && receipt.slug === input.slug
    && receipt.versionId === input.versionId
    && receipt.candidateId === input.candidateId
    && receipt.outcome === input.outcome;
}

function quarantine(path: string, reason: string): string {
  const dir = join(ledgerDir(), "quarantine");
  rejectSymlink(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${basename(path)}.${Date.now()}.${randomUUID()}.${reason}.corrupt`);
  renameSync(path, target);
  return target;
}

function outcomePaths(): string[] {
  const dir = outcomesDir();
  if (!existsSync(dir)) return [];
  rejectSymlink(dir);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort();
}

export function prepareLearnedOutcome(input: LearnedOutcomeInput): LearnedOutcomeReceipt {
  const pending = validateReceipt({
    schemaVersion: 1,
    status: "pending",
    opId: input.opId,
    sessionId: input.sessionId,
    slug: input.slug,
    versionId: input.versionId,
    candidateId: input.candidateId,
    outcome: input.outcome,
    timestamp: input.timestamp,
  });
  return withLedgerLock(() => {
    const path = receiptPath(input.opId);
    let existing: LearnedOutcomeReceipt | null;
    try { existing = readReceipt(path); }
    catch (error) {
      if (existsSync(path)) quarantine(path, "integrity");
      throw new Error(`Learned outcome integrity check failed: ${(error as Error).message}`);
    }
    if (existing) {
      if (!sameInput(existing, input)) throw new Error(`Conflicting learned outcome for op ${input.opId}`);
      return existing;
    }
    writeReceipt(path, pending);
    return pending;
  });
}

export function commitLearnedOutcome(opId: string): LearnedOutcomeReceipt {
  return withLedgerLock(() => {
    const path = receiptPath(opId);
    let current: LearnedOutcomeReceipt | null;
    try { current = readReceipt(path); }
    catch (error) {
      if (existsSync(path)) quarantine(path, "integrity");
      throw new Error(`Learned outcome integrity check failed: ${(error as Error).message}`);
    }
    if (!current) throw new Error(`No prepared learned outcome for op ${opId}`);
    if (current.status === "committed") return current;
    const committed: LearnedOutcomeReceipt = { ...current, status: "committed" };
    writeReceipt(path, committed);
    return committed;
  });
}

export function readLearnedOutcome(opId: string): LearnedOutcomeReceipt | null {
  return withLedgerLock(() => {
    const path = receiptPath(opId);
    try { return readReceipt(path); }
    catch (error) {
      if (existsSync(path)) quarantine(path, "integrity");
      throw new Error(`Learned outcome integrity check failed: ${(error as Error).message}`);
    }
  });
}

export function reconcilePendingLearnedOutcomes(
  readOp: (opId: string) => OpSnapshot | null,
  now = Date.now(),
  onCommitted?: (receipt: Readonly<LearnedOutcomeReceipt>) => void,
): EffectivenessReconcileReport {
  return withLedgerLock(() => {
    const report: EffectivenessReconcileReport = { committed: [], retained: [], quarantined: [] };
    for (const path of outcomePaths()) {
      let receipt: LearnedOutcomeReceipt;
      try { receipt = readReceipt(path)!; }
      catch {
        report.quarantined.push(quarantine(path, "integrity"));
        continue;
      }
      if (receipt.status === "committed") {
        const op = readOp(receipt.opId);
        const state = op?.canonical?.state ?? op?.status;
        if (state && TERMINAL.has(state) && !terminalAcceptsOutcome(state, receipt.outcome)) {
          report.quarantined.push(quarantine(path, "terminal-mismatch"));
          continue;
        }
        onCommitted?.(receipt);
        continue;
      }
      const op = readOp(receipt.opId);
      const state = op?.canonical?.state ?? op?.status;
      if (state && TERMINAL.has(state)) {
        if (!terminalAcceptsOutcome(state, receipt.outcome)) {
          report.quarantined.push(quarantine(path, "terminal-mismatch"));
          continue;
        }
        const committed: LearnedOutcomeReceipt = { ...receipt, status: "committed" };
        writeReceipt(path, committed);
        report.committed.push(receipt.opId);
        onCommitted?.(committed);
      } else if (!op && now - receipt.timestamp > MISSING_OP_TTL_MS) {
        report.quarantined.push(quarantine(path, "missing-op"));
      } else {
        report.retained.push(receipt.opId);
      }
    }
    return report;
  });
}

function committedReceipts(): LearnedOutcomeReceipt[] {
  const receipts: LearnedOutcomeReceipt[] = [];
  for (const path of outcomePaths()) {
    let receipt: LearnedOutcomeReceipt;
    try { receipt = readReceipt(path)!; }
    catch (error) {
      if (existsSync(path)) quarantine(path, "integrity");
      throw new Error(`Learned outcome integrity check failed: ${(error as Error).message}`);
    }
    if (receipt.status === "committed") receipts.push(receipt);
  }
  return receipts;
}

function metrics(slug: string, versionId: string, receipts: LearnedOutcomeReceipt[]): VersionEffectiveness {
  const matching = receipts.filter((receipt) => receipt.slug === slug && receipt.versionId === versionId);
  const candidates = new Set(matching.map((receipt) => receipt.candidateId));
  if (candidates.size > 1) throw new Error(`Conflicting candidate attribution for ${slug}@${versionId}`);
  const clean = matching.filter((receipt) => receipt.outcome === "clean").length;
  const partial = matching.filter((receipt) => receipt.outcome === "partial").length;
  const aborted = matching.filter((receipt) => receipt.outcome === "aborted").length;
  const total = matching.length;
  return {
    slug, versionId, candidateId: candidates.values().next().value ?? null,
    total, clean, partial, aborted,
    cleanRate: total ? clean / total : 0,
    partialRate: total ? partial / total : 0,
    abortedRate: total ? aborted / total : 0,
    qualityScore: total ? (clean + 0.5 * partial) / total : 0,
    distinctSessions: new Set(matching.map((receipt) => receipt.sessionId).filter(Boolean)).size,
    lastOutcomeAt: total ? Math.max(...matching.map((receipt) => receipt.timestamp)) : null,
  };
}

export function getVersionEffectiveness(slug: string, versionId: string): VersionEffectiveness {
  return withLedgerLock(() => metrics(slug, versionId, committedReceipts()));
}

export function listCandidateEffectiveness(candidateId: string): VersionEffectiveness[] {
  return withLedgerLock(() => {
    const receipts = committedReceipts().filter((receipt) => receipt.candidateId === candidateId);
    const keys = new Map<string, { slug: string; versionId: string }>();
    for (const receipt of receipts) keys.set(`${receipt.slug}\0${receipt.versionId}`, receipt);
    return [...keys.values()]
      .map(({ slug, versionId }) => metrics(slug, versionId, receipts))
      .sort((a, b) => (b.lastOutcomeAt ?? 0) - (a.lastOutcomeAt ?? 0));
  });
}

export function _setLearnedEffectivenessWriteHookForTests(
  hook?: (phase: WritePhase, receipt: Readonly<LearnedOutcomeReceipt>) => void,
): void {
  writeHook = hook;
}
