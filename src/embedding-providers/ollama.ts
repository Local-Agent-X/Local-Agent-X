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

  constructor(opts?: { model?: string; baseUrl?: string }) {
    // mxbai-embed-large (1024d) scored 97.0% R@5 on LongMemEval — #1 zero-cost.
    // nomic-embed-text (768d) scored ~95.5% R@5 — fallback if mxbai not available.
    // Strip ":latest" suffix — Ollama adds it but our knownDims don't include it.
    this.model = (opts?.model ?? "mxbai-embed-large").replace(/:latest$/, "");
    this.baseUrl = (opts?.baseUrl ?? getRuntimeConfig().ollamaUrl).replace(/\/$/, "");
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
      this.markUnhealthy(`embed: ${(e as Error).message}`);
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
      this.markUnhealthy(`embedBatch: ${(e as Error).message}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }

  private async embedRequest(input: string[], timeoutMs: number): Promise<{ embeddings: number[][] }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input, keep_alive: KEEP_ALIVE }),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new Error(`Ollama embed HTTP ${res.status}`);
      }
      return (await res.json()) as { embeddings: number[][] };
    } finally {
      clearTimeout(timer);
    }
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
    if (this.healthy === null) void this.probeInBackground();
    return this.healthy === true;
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

  private probeInBackground(): Promise<boolean> {
    this.probing ??= this.probe()
      .then((ok) => {
        this.healthy = ok;
        if (ok) logger.info(`[ollama-embed] healthy (model=${this.model})`);
        else this.scheduleRecheck();
        return ok;
      })
      .catch(() => {
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
    const { reachable, models } = await fetchLocalOllamaTags(this.baseUrl);
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
    const testRes = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: ["test"], keep_alive: KEEP_ALIVE }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (testRes.ok) return true;
    // Model not available — try fallback to nomic-embed-text
    if (!isLocalOnlyMode() && this.model !== "nomic-embed-text") {
      logger.warn(`[ollama-embed] Model "${this.model}" not available (HTTP ${testRes.status}) — falling back to nomic-embed-text`);
      this.model = "nomic-embed-text";
      this.dimensions = 768;
      const fallbackRes = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: ["test"], keep_alive: KEEP_ALIVE }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS / 2),
      });
      return fallbackRes.ok;
    }
    return false;
  }
}
