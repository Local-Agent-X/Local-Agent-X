import { performance } from "node:perf_hooks";
import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { fetchLocalOllamaTags } from "../ollama-cloud.js";
import { emptyVector } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";
import { isLocalOnlyMode, isLoopbackUrl } from "../local-only-policy.js";

const logger = createLogger("embedding-providers");

// Turn-path caps. A warm embed is sub-second (measured ~250ms); these only
// trip when Ollama is wedged or mid-model-load. Tripping flips the provider
// unhealthy so subsequent turn-path calls return instantly, and the
// background recheck restores service — the turn path itself never waits on
// sidecar lifecycle (model loads, health probes).
const EMBED_TIMEOUT_MS = 5_000;
const BATCH_TIMEOUT_MS = 20_000;
// Model load into GPU/RAM can take 30-60s — allowed only in the background probe.
const PROBE_TIMEOUT_MS = 60_000;
const RECHECK_DELAY_MS = 60_000;
// Pin the embed model resident. Ollama's default keep_alive is 5 minutes, so
// the model unloaded between chats and the next turn paid the reload.
const KEEP_ALIVE = "4h";
// A deadline is evidence about the SERVER only when this process was awake to
// enforce it. Every cap above is a Node timer, and a timer on a blocked loop
// fires the instant the loop resumes — this server has stalled 90-110s at a
// stretch (see server/event-loop-sentinel.ts), which aborts a request that
// never got a millisecond of service and then convicts Ollama for it. On a
// healthy loop a timer lands within a few ms of its deadline, so anything this
// far past its budget is a statement about THIS PROCESS, not about Ollama.
const LOOP_STARVATION_SLACK_MS = 1_000;
// Upper bound on how long an honest "not reachable" takes to render: the
// reachability probe's own connect budget (local-runtimes/ollama-probe.ts
// DETECT_TIMEOUT_MS, 1.5s). A refused connection answers in microseconds; a
// black-holed one at the budget. If that budget ever grows past this, the only
// cost is one extra /api/version GET against a genuinely down Ollama — never a
// wrong verdict.
const REACHABILITY_BUDGET_MS = 1_500;

/** Monotonic milliseconds. Date.now() would let an NTP step or a laptop resume
 *  fabricate — or hide — a stall. Same clock the loop sentinel measures with. */
const monotonicNowMs = (): number => Math.round(performance.now());

/**
 * True when a timed operation overran its budget by more than any healthy
 * loop's timer jitter — i.e. its deadline fired late because the loop was
 * starved, so the expiry says nothing about the endpoint.
 */
export function verdictWasStarved(elapsedMs: number, budgetMs: number): boolean {
  return elapsedMs - budgetMs >= LOOP_STARVATION_SLACK_MS;
}

/**
 * Ask "is Ollama reachable?", and re-ask ONCE when the answer was "no" and the
 * clock proves the loop was blocked while it was being decided. Shared with the
 * boot warmer (server/bootstrap-services.ts) so both doors to "Ollama is
 * down" — the boot tags probe and this provider's health probe — decide it by
 * one rule. A "yes", and a "no" rendered inside the probe's own budget, are
 * returned untouched: a genuinely down Ollama is still reported down, on the
 * first ask.
 *
 * Honest limit: the retake runs on a loop that is demonstrably alive right now,
 * but nothing stops a second stall from landing on top of it. Then the "no"
 * stands and the caller's existing recheck/retry asks again later — bounded and
 * self-correcting, unlike believing the first starved "no".
 */
export async function askReachableFairly<T extends { reachable: boolean }>(
  ask: () => Promise<T>,
  now: () => number = monotonicNowMs,
): Promise<T> {
  const startedAt = now();
  const first = await ask();
  if (first.reachable) return first;
  const elapsedMs = Math.round(now() - startedAt);
  if (!verdictWasStarved(elapsedMs, REACHABILITY_BUDGET_MS)) return first;
  logger.warn(
    `[ollama-embed] reachability check took ${elapsedMs}ms for a ${REACHABILITY_BUDGET_MS}ms probe — the event loop was blocked, so "unreachable" is not evidence; asking again`,
  );
  return ask();
}

/** OUR deadline aborted the request. Carries the clock evidence needed to tell
 *  "Ollama did not answer" from "this process never actually asked". */
class DeadlineExceeded extends Error {
  constructor(readonly elapsedMs: number, readonly budgetMs: number) {
    super(`deadline of ${budgetMs}ms expired after ${elapsedMs}ms`);
    this.name = "DeadlineExceeded";
  }

  /** The loop was blocked, so the request never got its budget. */
  get starved(): boolean {
    return verdictWasStarved(this.elapsedMs, this.budgetMs);
  }
}

export class OllamaEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "ollama";
  model: string;
  dimensions: number;
  readonly maxBatchSize = 10;

  private baseUrl: string;
  private healthy: boolean | null = null;
  private dimensionsDetected = false;
  private probing: Promise<boolean> | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  /** The one recovery subscriber (memory index) — see EmbeddingProvider.onRecovered. */
  private recoveredListener: (() => void) | null = null;
  /** Monotonic clock; injected in tests so starvation is driven, not slept. */
  private readonly now: () => number;

  constructor(opts?: { model?: string; baseUrl?: string; now?: () => number }) {
    // mxbai-embed-large (1024d) scored 97.0% R@5 on LongMemEval — #1 zero-cost.
    // nomic-embed-text (768d) scored ~95.5% R@5 — fallback if mxbai not available.
    // Strip ":latest" suffix — Ollama adds it but our knownDims don't include it.
    this.model = (opts?.model ?? "mxbai-embed-large").replace(/:latest$/, "");
    this.baseUrl = (opts?.baseUrl ?? getRuntimeConfig().ollamaUrl).replace(/\/$/, "");
    this.now = opts?.now ?? monotonicNowMs;
    // Default dimensions per known model, auto-detected on first embed call
    const knownDims: Record<string, number> = {
      "nomic-embed-text": 768, "mxbai-embed-large": 1024,
      "snowflake-arctic-embed:335m": 768, "all-minilm": 384,
      "bge-large": 1024, "bge-base": 768,
      "gte-large": 1024, "thenlper/gte-large": 1024,
      "BAAI/bge-large-en-v1.5": 1024, "e5-large": 1024,
    };
    this.dimensions = knownDims[this.model] || 768;
  }

  async embed(text: string): Promise<number[]> {
    if (isLocalOnlyMode() && !isLoopbackUrl(this.baseUrl)) return emptyVector(this.dimensions);
    if (!this.isHealthyNow()) return emptyVector(this.dimensions);
    if (!text || !text.trim()) return emptyVector(this.dimensions);
    // Truncate to ~512 tokens (~2000 chars) for models with smaller context windows
    const truncated = text.trim().slice(0, 2000);
    try {
      const json = await this.embedRequest([truncated], EMBED_TIMEOUT_MS);
      const vec = json.embeddings?.[0] ?? emptyVector(this.dimensions);
      this.detectDimensions(vec);
      return vec;
    } catch (e) {
      this.noteFailure("embed", e);
      return emptyVector(this.dimensions);
    }
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (isLocalOnlyMode() && !isLoopbackUrl(this.baseUrl)) return texts.map(() => emptyVector(this.dimensions));
    if (!this.isHealthyNow()) return texts.map(() => emptyVector(this.dimensions));
    // Filter out empty strings and truncate long text
    const cleaned = texts.map(t => (t && t.trim()) ? t.trim().slice(0, 2000) : null);
    const validTexts = cleaned.filter((t): t is string => t !== null);
    if (validTexts.length === 0) return texts.map(() => emptyVector(this.dimensions));
    try {
      const json = await this.embedRequest(validTexts, BATCH_TIMEOUT_MS);
      const validResults = json.embeddings ?? validTexts.map(() => emptyVector(this.dimensions));
      this.detectDimensions(validResults[0] ?? []);
      // Map results back to original positions
      let vi = 0;
      return cleaned.map(t => t !== null ? validResults[vi++] || emptyVector(this.dimensions) : emptyVector(this.dimensions));
    } catch (e) {
      // No per-item retry here: a failed batch means Ollama is wedged, and
      // re-embedding each item serially multiplied one 60s hang into minutes
      // of blocked callers. Callers that need durability (index-embedding)
      // carry their own retry; everyone else degrades on empty vectors.
      this.noteFailure("embedBatch", e);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }

  /**
   * Run one exchange under a deadline — body read included, so a response whose
   * stream hangs cannot outlive the budget. A failure raised while OUR abort is
   * the one that fired comes back as DeadlineExceeded carrying the elapsed
   * time; every other failure (refused, reset, HTTP status) is re-thrown
   * untouched, so a genuinely down Ollama still convicts on the first try.
   */
  private async underDeadline<T>(budgetMs: number, exchange: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const startedAt = this.now();
    const timer = setTimeout(() => ac.abort(), budgetMs);
    try {
      return await exchange(ac.signal);
    } catch (e) {
      if (ac.signal.aborted) throw new DeadlineExceeded(Math.round(this.now() - startedAt), budgetMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private embedRequest(input: string[], timeoutMs: number): Promise<{ embeddings: number[][] }> {
    return this.underDeadline(timeoutMs, async (signal) => {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input, keep_alive: KEEP_ALIVE }),
        signal,
      });
      if (!res.ok) {
        throw new Error(`Ollama embed HTTP ${res.status}`);
      }
      return (await res.json()) as { embeddings: number[][] };
    });
  }

  /** One-item embed that proves the model can actually serve. Same deadline
   *  discipline as the turn path, with the model-load budget. */
  private probeEmbed(budgetMs: number): Promise<Response> {
    return this.underDeadline(budgetMs, (signal) =>
      fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: ["test"], keep_alive: KEEP_ALIVE }),
        signal,
      }));
  }

  private detectDimensions(vec: number[]): void {
    if (!this.dimensionsDetected && vec.length > 0) {
      this.dimensions = vec.length;
      this.dimensionsDetected = true;
    }
  }

  /**
   * Non-blocking health gate. Unknown health kicks a background probe and
   * reports unhealthy for THIS call — callers degrade to empty vectors
   * instead of waiting up to 60s for a model load inside a chat turn. The
   * boot pre-warm normally completes the probe before any user turn.
   */
  private isHealthyNow(): boolean {
    // `!this.recheckTimer`: a withheld verdict (below) leaves health unknown
    // with a recheck already armed — without this guard every subsequent call
    // would kick a fresh probe at a server we've decided not to judge yet.
    if (this.healthy === null && !this.recheckTimer) void this.probeInBackground();
    return this.healthy === true;
  }

  /**
   * Weigh a failed request before touching health. A deadline that fired late
   * only because the loop was blocked is not evidence about Ollama —
   * convicting on it dropped memory retrieval to keyword-only for a whole
   * recheck window while Ollama was up and serving (2026-07-28: "degraded
   * (embed: This operation was aborted)" logged immediately after a long
   * stall). The call still degrades to an empty vector; health is left alone,
   * so the NEXT call goes back to the network instead of being pre-failed.
   *
   * Withheld is not "assume fine": it arms the same background recheck a
   * conviction would, so an Ollama that really is wedged is still convicted —
   * by a probe that ran on a live loop and can therefore be believed.
   */
  private noteFailure(op: string, e: unknown): void {
    if (e instanceof DeadlineExceeded && e.starved) {
      logger.warn(
        `[ollama-embed] ${op} deadline (${e.budgetMs}ms) fired after ${e.elapsedMs}ms — the event loop was blocked, not Ollama; verdict withheld, health unchanged, rechecking in ${RECHECK_DELAY_MS}ms`,
      );
      this.scheduleRecheck();
      return;
    }
    this.markUnhealthy(`${op}: ${(e as Error).message}`);
  }

  private markUnhealthy(reason: string): void {
    if (this.healthy !== false) {
      logger.warn(`[ollama-embed] degraded (${reason}) — embeddings return empty until recheck succeeds`);
    }
    this.healthy = false;
    this.scheduleRecheck();
  }

  private scheduleRecheck(): void {
    if (this.recheckTimer) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.probeInBackground();
    }, RECHECK_DELAY_MS);
    this.recheckTimer.unref?.();
  }

  onRecovered(listener: () => void): () => void {
    this.recoveredListener = listener;
    return () => {
      if (this.recoveredListener === listener) this.recoveredListener = null;
    };
  }

  /**
   * Health just flipped to serving. The listener runs isolated: a throw here
   * would land in probeInBackground's .catch and convict a server that has
   * just proved it is healthy.
   */
  private notifyRecovered(): void {
    const listener = this.recoveredListener;
    if (!listener) return;
    try {
      listener();
    } catch (e) {
      logger.warn(`[ollama-embed] onRecovered listener failed: ${(e as Error).message}`);
    }
  }

  private probeInBackground(): Promise<boolean> {
    this.probing ??= this.probe()
      .then((ok) => {
        const wasServing = this.healthy === true;
        this.healthy = ok;
        if (ok) {
          logger.info(`[ollama-embed] healthy (model=${this.model})`);
          // Unknown→healthy counts as a recovery too: boot attaches the memory
          // index before the warm-up probe settles, so chunks indexed in that
          // window are as vector-less as ones indexed during an outage.
          if (!wasServing) this.notifyRecovered();
        } else {
          this.scheduleRecheck();
        }
        return ok;
      })
      .catch((e) => {
        // Same rule as the turn path: a probe whose deadline expired only
        // because the loop was blocked proves nothing. Leave health as it was
        // and let the already-armed recheck ask again on a live loop.
        if (e instanceof DeadlineExceeded && e.starved) {
          logger.warn(
            `[ollama-embed] probe deadline (${e.budgetMs}ms) fired after ${e.elapsedMs}ms — the event loop was blocked, not Ollama; health left unchanged, rechecking in ${RECHECK_DELAY_MS}ms`,
          );
          this.scheduleRecheck();
          return this.healthy === true;
        }
        this.healthy = false;
        this.scheduleRecheck();
        return false;
      })
      .finally(() => {
        this.probing = null;
      });
    return this.probing;
  }

  /** Test hook + boot warm: resolves when a probe settles health. */
  async ensureHealthy(): Promise<boolean> {
    if (this.healthy !== null) return this.healthy;
    return this.probeInBackground();
  }

  private async probe(): Promise<boolean> {
    if (isLocalOnlyMode() && !isLoopbackUrl(this.baseUrl)) return false;
    const { reachable, models } = await askReachableFairly(() => fetchLocalOllamaTags(this.baseUrl), this.now);
    if (!reachable) {
      logger.warn(`[ollama-embed] Server at ${this.baseUrl} not reachable`);
      return false;
    }
    if (isLocalOnlyMode() && !models.some((entry) => entry.name.replace(/:latest$/, "") === this.model)) {
      return false;
    }
    // Verify the model is actually available — do a test embed. First call to
    // a large model can take 30-60s to load into GPU/RAM; that cost lives
    // here, in the background, never in a caller's turn.
    const testRes = await this.probeEmbed(PROBE_TIMEOUT_MS);
    if (testRes.ok) return true;
    // Model not available — try fallback to nomic-embed-text
    if (!isLocalOnlyMode() && this.model !== "nomic-embed-text") {
      logger.warn(`[ollama-embed] Model "${this.model}" not available (HTTP ${testRes.status}) — falling back to nomic-embed-text`);
      this.model = "nomic-embed-text";
      this.dimensions = 768;
      const fallbackRes = await this.probeEmbed(PROBE_TIMEOUT_MS / 2);
      return fallbackRes.ok;
    }
    return false;
  }
}
