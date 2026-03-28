import { createHash } from "node:crypto";

interface CacheEntry {
  response: unknown;
  expiresAt: number;
  createdAt: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 100;

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  static buildKey(model: string, messages: unknown[], temperature: number): string {
    const payload = JSON.stringify({ model, messages, temperature });
    return createHash("sha256").update(payload).digest("hex");
  }

  get(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.response;
  }

  set(key: string, response: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
    // Evict expired entries first
    this.evictExpired();

    // If still at capacity, remove the oldest entry
    if (this.cache.size >= MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      response,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
    });
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  shouldCache(temperature: number): boolean {
    return temperature <= 0;
  }
}
