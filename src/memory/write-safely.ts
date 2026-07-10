/**
 * Single safety gate for every memory write (audit finding F5).
 *
 * Pipeline (every call, every time):
 *   normalize → checkMemoryTaint(threshold) → sanitizeForMemory
 *   → redactKnownSecrets → redact(shape catalog) → write
 *
 * Callers may RAISE threshold (less strict) but cannot skip the chain.
 *
 * Soak: LAX_MEMORY_WRITE_AUDIT=1 turns blocks into log-only entries
 * under logs/memory-write-audit.log so we can eyeball would-have-blocks
 * before flipping enforcement on by default.
 */
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  checkMemoryTaint,
  normalizeHomoglyphs,
  redactKnownSecrets,
  sanitizeForMemory,
  stripControlChars,
} from "../sanitize.js";
import { redact } from "../security/credential-patterns.js";
import { createLogger } from "../logger.js";
import { atomicWriteFileSync } from "./utils.js";
import { PERSONALITY_FILES } from "./personality.js";
import type { MemoryIndex } from "./index-core.js";
import {
  assertMemoryPromotionAllowed,
  type MemoryPromotionContext,
} from "./promotion-gate.js";

const logger = createLogger("memory.write-safely");

// Narrative-profile files (USER/IDENTITY/HEART) are size-capped on EVERY
// overwrite here — the single write gate — so no writer can balloon them.
// auto-extract and sync bypassed the per-tool cap and let USER.md accrete
// duplicate blocks to 12KB. The cap is a hard backstop that SURFACES an
// over-limit (callers catch MemoryWriteBlocked) instead of growing silently.
// Dedup/merge deliberately stays in the writers that emit conforming bullet
// markdown (end-of-turn, memory_update_profile) — running the bullet-dedup
// here would strip the free-form prose HEART/IDENTITY and ad-hoc writes carry.
export const MAX_PROFILE_CHARS = 8000;

export type MemoryWriteSource =
  | "tool"
  | "eot"
  | "auto-extract"
  | "sync"
  | "personality";

export interface MemoryWriteParams {
  content: string;
  source: MemoryWriteSource;
  /** Absolute file path being written; used for routing + audit records. */
  target: string;
  /** Block when injection score ≥ threshold. Default 0.3 (strict). */
  threshold?: number;
  mode?: "append" | "overwrite";
  promotion?: MemoryPromotionContext;
}

export class MemoryWriteBlocked extends Error {
  readonly reason: string;
  readonly injectionScore: number;
  readonly source: MemoryWriteSource;
  readonly target: string;
  constructor(opts: {
    reason: string;
    injectionScore: number;
    source: MemoryWriteSource;
    target: string;
  }) {
    super(
      `Memory write blocked (${opts.source} → ${opts.target}): ${opts.reason}`,
    );
    this.name = "MemoryWriteBlocked";
    this.reason = opts.reason;
    this.injectionScore = opts.injectionScore;
    this.source = opts.source;
    this.target = opts.target;
  }
}

const DEFAULT_THRESHOLD = 0.3;
const auditMode = (): boolean => process.env.LAX_MEMORY_WRITE_AUDIT === "1";

// ── Write clock ──
//
// In-memory monotonic clock over memory writes that actually landed, tracked
// per source. Post-turn machinery (extraction-coalescer) asks "has a
// main-agent ('tool') write happened since tick X?" to avoid re-curating a
// profile the agent just curated itself. Blocked writes (MemoryWriteBlocked)
// never tick — only content that reached disk counts. Process-local; resets
// on restart (a stale cursor after restart is benign — one extra or skipped
// end-of-turn pass, self-correcting).

let writeTick = 0;
const lastTickBySource = new Map<MemoryWriteSource, number>();

function noteWrite(source: MemoryWriteSource): void {
  writeTick += 1;
  lastTickBySource.set(source, writeTick);
}

/** Current global write-clock tick (0 = no memory writes this process). */
export function getMemoryWriteTick(): number {
  return writeTick;
}

/** Tick of the last landed write from `source` (0 = none this process). */
export function getLastWriteTick(source: MemoryWriteSource): number {
  return lastTickBySource.get(source) ?? 0;
}

/** Write content to a memory file after the full safety chain. */
export function writeMemorySafely(params: MemoryWriteParams): void {
  const sanitized = applyGateChain({
    content: params.content,
    source: params.source,
    target: params.target,
    threshold: params.threshold,
    promotion: params.promotion,
  });
  const mode = params.mode ?? "overwrite";
  if (mode === "append") {
    appendFileSync(params.target, sanitized, "utf-8");
    noteWrite(params.source);
    return;
  }

  // Cap profile files on every overwrite, whichever writer called us. Read
  // PERSONALITY_FILES at call time (not module load) — write-safely and
  // personality import each other, so the binding is only safe to touch once
  // both modules have finished evaluating.
  if (Object.values(PERSONALITY_FILES).includes(basename(params.target)) && sanitized.length > MAX_PROFILE_CHARS) {
    throw new MemoryWriteBlocked({
      reason: `${basename(params.target)} would be ${sanitized.length}/${MAX_PROFILE_CHARS} chars — consolidate it before adding more`,
      injectionScore: 0,
      source: params.source,
      target: params.target,
    });
  }

  snapshotBeforeOverwrite(params.target, sanitized);
  atomicWriteFileSync(params.target, sanitized);
  noteWrite(params.source);
}

// ── Overwrite history ──
//
// atomicWriteFileSync protects against crash-corruption, not bad content:
// a bungled profile rewrite or dedupe pass used to be unrecoverable because
// ~/.lax/memory is deliberately untracked. Every overwrite through this gate
// first copies the old version into a sibling `.history/` dir (dot-dirs are
// skipped by listMemoryFiles, so snapshots never index). Restore = copy the
// snapshot back. Local-only; nothing syncs or pushes.

const HISTORY_DIR = ".history";
const HISTORY_KEEP = 20;

function snapshotBeforeOverwrite(target: string, incoming: string): void {
  try {
    if (!existsSync(target)) return;
    const prev = readFileSync(target, "utf-8");
    if (!prev.trim() || prev === incoming) return;
    const dir = join(dirname(target), HISTORY_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const name = basename(target);
    // ISO stamp with ms — lexicographic order == chronological order.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(dir, `${name}.${stamp}`), prev, "utf-8");
    const snapshots = readdirSync(dir).filter((f) => f.startsWith(`${name}.`)).sort();
    for (const f of snapshots.slice(0, Math.max(0, snapshots.length - HISTORY_KEEP))) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  } catch (e) {
    // History is a safety net, never a write blocker.
    logger.warn(`history snapshot failed for ${target}: ${(e as Error).message}`);
  }
}

/** Append to today's daily log via MemoryIndex (keeps markDirty + reindex). */
export function appendToDailyLogSafely(opts: {
  memory: MemoryIndex;
  content: string;
  source: MemoryWriteSource;
  sessionId?: string;
  threshold?: number;
  promotion?: MemoryPromotionContext;
}): void {
  const sanitized = applyGateChain({
    content: opts.content,
    source: opts.source,
    target: opts.memory.getDailyLogPath(),
    threshold: opts.threshold,
    promotion: opts.promotion,
  });
  opts.memory.appendDailyLog(sanitized, opts.sessionId, opts.source, { origin: "durable_memory" });
  noteWrite(opts.source);
}

/**
 * Gate-only — for sinks that aren't a file write (e.g. memory.retain
 * stores facts in the DB). Returns sanitized content or throws.
 */
export function runMemoryGate(opts: {
  content: string;
  source: MemoryWriteSource;
  target: string;
  threshold?: number;
  promotion?: MemoryPromotionContext;
}): string {
  return applyGateChain(opts);
}

interface GateInput {
  content: string;
  source: MemoryWriteSource;
  target: string;
  threshold?: number;
  promotion?: MemoryPromotionContext;
}

function applyGateChain(input: GateInput): string {
  try {
    assertMemoryPromotionAllowed(input.content, input.target, input.promotion);
  } catch (e) {
    throw new MemoryWriteBlocked({
      reason: (e as Error).message,
      injectionScore: 0,
      source: input.source,
      target: input.target,
    });
  }
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const normalized = normalizeHomoglyphs(stripControlChars(input.content));

  // Score-based block. checkMemoryTaint already normalizes; we gate on
  // the score so callers that raise threshold get the looser behavior.
  const taint = checkMemoryTaint(normalized);
  if (taint.injectionScore >= threshold) {
    const blockInfo = {
      reason:
        taint.reason ??
        `injection score ${taint.injectionScore.toFixed(2)} ≥ threshold ${threshold}`,
      injectionScore: taint.injectionScore,
      source: input.source,
      target: input.target,
    };
    if (auditMode()) {
      logAuditEvent(blockInfo, normalized);
    } else {
      throw new MemoryWriteBlocked(blockInfo);
    }
  }

  let result = sanitizeForMemory(normalized);
  result = redactKnownSecrets(result);
  result = redact(result);
  return result;
}

function logAuditEvent(
  info: {
    reason: string;
    injectionScore: number;
    source: string;
    target: string;
  },
  preview: string,
): void {
  try {
    const auditPath = join(process.cwd(), "logs", "memory-write-audit.log");
    const dir = dirname(auditPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      source: info.source,
      target: info.target,
      injectionScore: info.injectionScore,
      reason: info.reason,
      preview: preview.slice(0, 200),
    };
    appendFileSync(auditPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (e) {
    logger.warn(`audit log failed: ${(e as Error).message}`);
  }
}
