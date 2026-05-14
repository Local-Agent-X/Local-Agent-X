/**
 * Single safety gate for every memory write (audit finding F5).
 *
 * Pipeline (every call, every time):
 *   normalize → checkMemoryTaint(threshold) → sanitizeForMemory
 *   → redactKnownSecrets → write
 *
 * Callers may RAISE threshold (less strict) but cannot skip the chain.
 *
 * Soak: LAX_MEMORY_WRITE_AUDIT=1 turns blocks into log-only entries
 * under logs/memory-write-audit.log so we can eyeball would-have-blocks
 * before flipping enforcement on by default.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  checkMemoryTaint,
  normalizeHomoglyphs,
  redactKnownSecrets,
  sanitizeForMemory,
  stripControlChars,
} from "../sanitize.js";
import { createLogger } from "../logger.js";
import { atomicWriteFileSync } from "./utils.js";
import type { MemoryIndex } from "./index-core.js";

const logger = createLogger("memory.write-safely");

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

/** Write content to a memory file after the full safety chain. */
export function writeMemorySafely(params: MemoryWriteParams): void {
  const sanitized = applyGateChain({
    content: params.content,
    source: params.source,
    target: params.target,
    threshold: params.threshold,
  });
  const mode = params.mode ?? "overwrite";
  if (mode === "append") {
    appendFileSync(params.target, sanitized, "utf-8");
  } else {
    atomicWriteFileSync(params.target, sanitized);
  }
}

/** Append to today's daily log via MemoryIndex (keeps markDirty + reindex). */
export function appendToDailyLogSafely(opts: {
  memory: MemoryIndex;
  content: string;
  source: MemoryWriteSource;
  sessionId?: string;
  threshold?: number;
}): void {
  const sanitized = applyGateChain({
    content: opts.content,
    source: opts.source,
    target: opts.memory.getDailyLogPath(),
    threshold: opts.threshold,
  });
  opts.memory.appendDailyLog(sanitized, opts.sessionId);
}

/** Replace MIND.md via MemoryIndex (keeps markDirty + reindex). */
export function writeMindFileSafely(opts: {
  memory: MemoryIndex;
  content: string;
  source: MemoryWriteSource;
  threshold?: number;
}): void {
  const sanitized = applyGateChain({
    content: opts.content,
    source: opts.source,
    target: opts.memory.getMemoryFilePath(),
    threshold: opts.threshold,
  });
  opts.memory.writeMemoryFile(sanitized);
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
}): string {
  return applyGateChain(opts);
}

interface GateInput {
  content: string;
  source: MemoryWriteSource;
  target: string;
  threshold?: number;
}

function applyGateChain(input: GateInput): string {
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
