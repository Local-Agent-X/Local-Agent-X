/** Periodic lifecycle for the canonical stale-operation recovery sweep. */
import { createLogger } from "../logger.js";
import { getLeaseConfig } from "./lease.js";
import { sweepStaleCanonicalOpsCooperatively } from "./recovery.js";

const logger = createLogger("canonical-loop.recovery-janitor");

type Timer = ReturnType<typeof setTimeout>;

export interface RecoveryJanitorOptions {
  intervalMs?: number;
  sweep?: () => unknown | Promise<unknown>;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  onError?: (error: unknown) => void;
}

export class RecoveryJanitor {
  private readonly intervalMs: number;
  private readonly sweep: () => unknown | Promise<unknown>;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly onError: (error: unknown) => void;
  private timer: Timer | null = null;
  private started = false;
  private sweeping = false;

  constructor(options: RecoveryJanitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? getLeaseConfig().leaseDurationMs;
    if (this.intervalMs <= 0) throw new Error("Recovery janitor interval must be positive");
    this.sweep = options.sweep ?? sweepStaleCanonicalOpsCooperatively;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onError = options.onError ?? ((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[canonical-loop] recovery janitor sweep failed: ${message}`);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Run one sweep now. A concurrent call is dropped instead of overlapping. */
  async sweepNow(): Promise<boolean> {
    if (this.sweeping) return false;
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (error) {
      try { this.onError(error); } catch { /* diagnostics cannot kill the janitor */ }
    } finally {
      this.sweeping = false;
    }
    return true;
  }

  private scheduleNext(): void {
    if (!this.started || this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.sweepNow().finally(() => this.scheduleNext());
    }, this.intervalMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }
}

let activeJanitor: RecoveryJanitor | null = null;

/** Start the one process-wide recovery janitor. Idempotent across boot calls. */
export function startRecoveryJanitor(options: RecoveryJanitorOptions = {}): RecoveryJanitor {
  if (!activeJanitor) activeJanitor = new RecoveryJanitor(options);
  activeJanitor.start();
  return activeJanitor;
}

/** Stop the process-wide janitor while retaining its in-flight coordination. */
export function stopRecoveryJanitor(): void {
  activeJanitor?.stop();
}

export function isRecoveryJanitorStarted(): boolean {
  return activeJanitor?.isStarted() ?? false;
}
