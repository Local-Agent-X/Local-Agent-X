// ── Transient-error classification ──
//
// Identify provider errors that are worth failing over to another provider
// rather than propagating to the user. These are errors where the *current
// provider* is at fault (rate-limited, out of quota, having an outage) —
// retrying with a different provider should succeed.
//
// NOT included: 400s that are the caller's fault (bad request shape,
// unsupported model parameter) — those won't improve by switching providers.

export type TransientErrorKind = "rate-limit" | "auth" | "overload" | "network" | "content-filter" | null;

export function classifyProviderError(err: unknown): TransientErrorKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return null;

  // Content moderation / safety filter. The request CAN succeed on another
  // provider with different moderation (e.g. Claude), so we treat it as
  // transient for failover purposes even though the current provider won't
  // un-block on retry.
  if (
    msg.includes("content_filter") ||
    msg.includes("content moderation") ||
    msg.includes("content policy") ||
    msg.includes("safety filter") ||
    msg.includes("moderation loop")
  ) return "content-filter";

  // Rate limit / quota
  if (
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("quota") ||
    msg.includes("insufficient_quota")
  ) return "rate-limit";

  // Auth (expired token, revoked key)
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid_api_key") ||
    msg.includes("authentication") && msg.includes("fail") ||
    msg.includes("token expired") ||
    msg.includes("expired_token")
  ) return "auth";

  // Provider-side outages / overload
  if (
    msg.includes("overloaded") ||
    msg.includes("service unavailable") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500") ||
    msg.includes("504") ||
    msg.includes("gateway") ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway")
  ) return "overload";

  // Network
  if (
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  ) return "network";

  return null;
}

interface ProviderHealth {
  consecutiveFailures: number;
  unhealthySince: number | null;
}

export interface FallbackResult<T> {
  provider: string;
  result: T;
  attemptedProviders: string[];
}

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;

export class ProviderChain {
  private health: Map<string, ProviderHealth> = new Map();

  private getHealth(provider: string): ProviderHealth {
    let h = this.health.get(provider);
    if (!h) {
      h = { consecutiveFailures: 0, unhealthySince: null };
      this.health.set(provider, h);
    }
    return h;
  }

  private isAvailable(provider: string): boolean {
    const h = this.getHealth(provider);
    if (h.unhealthySince === null) return true;
    return Date.now() - h.unhealthySince >= COOLDOWN_MS;
  }

  private markSuccess(provider: string): void {
    const h = this.getHealth(provider);
    h.consecutiveFailures = 0;
    h.unhealthySince = null;
  }

  private markFailure(provider: string): void {
    const h = this.getHealth(provider);
    h.consecutiveFailures++;
    if (h.consecutiveFailures >= FAILURE_THRESHOLD) {
      h.unhealthySince = Date.now();
    }
  }

  async tryProvider<T>(
    providers: string[],
    requestFn: (provider: string) => Promise<T>,
  ): Promise<FallbackResult<T>> {
    const attempted: string[] = [];
    let lastError: unknown;

    for (const provider of providers) {
      if (!this.isAvailable(provider)) continue;

      attempted.push(provider);
      try {
        const result = await requestFn(provider);
        this.markSuccess(provider);
        return { provider, result, attemptedProviders: attempted };
      } catch (err) {
        lastError = err;
        this.markFailure(provider);
        console.log(
          `[fallback] provider "${provider}" failed (${this.getHealth(provider).consecutiveFailures} consecutive), trying next`,
        );
      }
    }

    // If all available providers failed, try unhealthy ones past cooldown as last resort
    for (const provider of providers) {
      if (attempted.includes(provider)) continue;
      attempted.push(provider);
      try {
        const result = await requestFn(provider);
        this.markSuccess(provider);
        return { provider, result, attemptedProviders: attempted };
      } catch (err) {
        lastError = err;
        this.markFailure(provider);
      }
    }

    throw lastError ?? new Error("No providers available");
  }

  getProviderStatus(): Record<string, { available: boolean; failures: number }> {
    const status: Record<string, { available: boolean; failures: number }> = {};
    for (const [name, h] of this.health) {
      status[name] = {
        available: this.isAvailable(name),
        failures: h.consecutiveFailures,
      };
    }
    return status;
  }

  resetProvider(provider: string): void {
    this.health.delete(provider);
  }
}
