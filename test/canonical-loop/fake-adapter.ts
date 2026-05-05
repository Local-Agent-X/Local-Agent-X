/**
 * Programmable FakeAdapter (Issue 02).
 *
 * Conforms to the locked PRD §15 adapter contract. Tests pre-arrange a
 * "script" of turn plans; each turn plan is an ordered list of
 * `adapter_report` items (with optional inter-item delays) plus a final
 * `TurnResult`. `runTurn()` walks the plan emitting reports, yielding
 * cooperatively so `abort()` can preempt mid-stream.
 *
 * abort() semantics (PRD §15):
 *   - Idempotent (calling twice is a no-op).
 *   - Safe on a completed adapter.
 *   - Resolves only when the adapter is actually stopped.
 *
 * Contract-only file — no DB handle, no `op_events` writer, no worker pool
 * import (PRD §15 sandbox; conformance item I).
 */
import type {
  Adapter,
  AdapterReport,
  TurnInput,
  TurnResult,
} from "../../src/canonical-loop/adapter-contract.js";
import type { ProviderStateEnvelope } from "../../src/canonical-loop/types.js";

// ── Script types ─────────────────────────────────────────────────────────

export interface ScriptedReport {
  /** Delay (ms) BEFORE emitting this report. Lets tests simulate streaming. */
  delayMs?: number;
  report: AdapterReport;
}

export interface TurnPlan {
  reports: ScriptedReport[];
  result: TurnResult;
  /** Optional: throw a real exception out of runTurn (used for negative tests). */
  throwInsteadOfReturning?: Error;
}

// ── Helpers for building scripts ─────────────────────────────────────────

let providerStateSeq = 0;
function makeProviderState(payload: unknown = {}): ProviderStateEnvelope {
  return {
    adapterName: "fake",
    adapterVersion: "0.0.1",
    providerPayload: { seq: ++providerStateSeq, ...(payload as Record<string, unknown>) },
  };
}

/** One-line "happy" turn: assistant message_finalized, then done. */
export function scriptTurn(opts: {
  text?: string;
  streamChunks?: unknown[];
  toolCalls?: { toolCallId: string; tool: string; args: unknown }[];
  errorReports?: { code: string; message: string; retryable: boolean }[];
  terminal?: "done" | "error";
  providerStatePayload?: unknown;
} = {}): TurnPlan {
  const reports: ScriptedReport[] = [];
  for (const chunk of opts.streamChunks ?? []) {
    reports.push({ delayMs: 5, report: { kind: "stream_chunk", body: chunk } });
  }
  for (const tc of opts.toolCalls ?? []) {
    reports.push({ report: { kind: "tool_call_requested", call: tc } });
  }
  if (opts.text !== undefined) {
    reports.push({
      report: {
        kind: "message_finalized",
        message: {
          messageId: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          role: "assistant",
          content: { text: opts.text },
        },
      },
    });
  }
  for (const e of opts.errorReports ?? []) {
    reports.push({ report: { kind: "error", ...e } });
  }
  return {
    reports,
    result: {
      providerState: makeProviderState(opts.providerStatePayload),
      terminalReason: opts.terminal,
    },
  };
}

/** Multi-turn convenience: run scriptTurn() per slot. Last gets terminal=done if unset. */
export function scriptMultiTurn(turns: Parameters<typeof scriptTurn>[0][]): TurnPlan[] {
  return turns.map((t, i) => {
    const isLast = i === turns.length - 1;
    return scriptTurn({
      ...t,
      terminal: t.terminal ?? (isLast ? "done" : undefined),
    });
  });
}

/** A turn plan that streams indefinitely until aborted. Used for abort()/cancel tests. */
export function scriptLongStreamingTurn(
  opts: { chunkIntervalMs?: number; maxChunks?: number } = {},
): TurnPlan {
  const chunks = Math.max(1, opts.maxChunks ?? 200);
  const interval = Math.max(1, opts.chunkIntervalMs ?? 25);
  const reports: ScriptedReport[] = [];
  for (let i = 0; i < chunks; i++) {
    reports.push({ delayMs: interval, report: { kind: "stream_chunk", body: { tick: i } } });
  }
  return {
    reports,
    result: {
      providerState: makeProviderState({ longStream: true }),
      terminalReason: "done",
    },
  };
}

// ── FakeAdapter ──────────────────────────────────────────────────────────

export interface FakeAdapterOpts {
  script?: TurnPlan[];
  /**
   * Optional override of provider name/version. Defaults to "fake"/"0.0.1".
   * Pass a different name to simulate a non-matching `provider_state` envelope.
   */
  name?: string;
  version?: string;
}

export class FakeAdapter implements Adapter {
  readonly name: string;
  readonly version: string;

  private readonly script: TurnPlan[];
  private turnsRun = 0;
  private aborted = false;
  /** Resolved when no `runTurn` is in flight (i.e. adapter is "actually stopped"). */
  private inflight: Promise<unknown> | null = null;

  // ── Inspection (test-only) ─────────────────────────────────────────────
  public emittedReports: AdapterReport[] = [];
  public turnInputs: TurnInput[] = [];
  public abortCalls = 0;

  constructor(opts: FakeAdapterOpts = {}) {
    this.script = opts.script ? [...opts.script] : [];
    this.name = opts.name ?? "fake";
    this.version = opts.version ?? "0.0.1";
  }

  /** Append plans without resetting state. */
  enqueueTurn(plan: TurnPlan): void {
    this.script.push(plan);
  }

  async runTurn(
    input: TurnInput,
    report: (r: AdapterReport) => void,
  ): Promise<TurnResult> {
    this.turnInputs.push(input);

    if (this.aborted) {
      // Already-aborted adapter still produces a clean error (never throws).
      const err: AdapterReport = {
        kind: "error",
        code: "aborted",
        message: "adapter was aborted before runTurn",
        retryable: false,
      };
      this.emittedReports.push(err);
      report(err);
      return {
        providerState: makeProviderState({ aborted: true }),
        terminalReason: "error",
      };
    }

    const plan = this.script[this.turnsRun] ?? scriptTurn({ text: "", terminal: "done" });
    this.turnsRun++;

    const work = this.driveTurn(plan, report);
    this.inflight = work;
    try {
      return await work;
    } finally {
      this.inflight = null;
    }
  }

  private async driveTurn(
    plan: TurnPlan,
    report: (r: AdapterReport) => void,
  ): Promise<TurnResult> {
    if (plan.throwInsteadOfReturning) {
      // Negative test path: contract says routine errors must surface as
      // `report({kind: "error"})`, NOT exceptions out of runTurn. We
      // expose this affordance only so the conformance suite can verify
      // the caller is robust if a buggy adapter throws.
      throw plan.throwInsteadOfReturning;
    }

    for (const item of plan.reports) {
      if (this.aborted) break;
      if (item.delayMs && item.delayMs > 0) {
        await this.abortableSleep(item.delayMs);
      }
      if (this.aborted) break;
      this.emittedReports.push(item.report);
      report(item.report);
    }

    if (this.aborted) {
      const err: AdapterReport = {
        kind: "error",
        code: "aborted",
        message: "adapter aborted mid-stream",
        retryable: false,
      };
      this.emittedReports.push(err);
      report(err);
      return {
        providerState: makeProviderState({ aborted: true }),
        terminalReason: "error",
      };
    }
    return plan.result;
  }

  private async abortableSleep(ms: number): Promise<void> {
    const start = Date.now();
    // Polling sleep so abort can preempt mid-delay. 5ms tick is plenty
    // fine-grained for tests (PRD says abort within 1s).
    while (Date.now() - start < ms) {
      if (this.aborted) return;
      await new Promise<void>(r => setTimeout(r, Math.min(5, ms)));
    }
  }

  async abort(): Promise<void> {
    this.abortCalls++;
    this.aborted = true;
    // Resolve only when any in-flight runTurn has completed.
    if (this.inflight) {
      try { await this.inflight; } catch { /* swallow — we just need it to drain */ }
    }
  }

  // ── Test introspection ────────────────────────────────────────────────

  /** Stream chunks emitted in order. */
  streamChunks(): unknown[] {
    return this.emittedReports
      .filter(r => r.kind === "stream_chunk")
      .map(r => (r as { kind: "stream_chunk"; body: unknown }).body);
  }

  /** Provider states this adapter received via TurnInput.providerState. */
  receivedProviderStates(): (ProviderStateEnvelope | undefined)[] {
    return this.turnInputs.map(t => t.providerState);
  }

  /** True if abort() has been called at least once. */
  isAborted(): boolean {
    return this.aborted;
  }
}
