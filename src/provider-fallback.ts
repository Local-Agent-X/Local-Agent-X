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
