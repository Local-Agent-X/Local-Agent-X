import type { RateLimitConfig } from "./types.js";

const monotonicNow = typeof performance !== 'undefined' ? () => Math.floor(performance.now()) : () => Date.now();

/**
 * Per-principal sliding window rate limiter and concurrency tracker.
 * All state is in-memory — resets on sidecar restart.
 */
export class RateLimiter {
	private readonly config: Required<RateLimitConfig>;
	/** Per-principal request timestamps (sliding window). */
	private readonly requestWindows = new Map<string, number[]>();
	/** Per-principal concurrent execution count. */
	private readonly concurrentExecs = new Map<string, number>();
	/** Global concurrent execution count. */
	private globalConcurrent = 0;

	constructor(config: RateLimitConfig = {}) {
		this.config = {
			maxFirewallsPerPrincipal: config.maxFirewallsPerPrincipal ?? 0,
			maxConcurrentExecutions: config.maxConcurrentExecutions ?? 0,
			maxRequestsPerSecond: config.maxRequestsPerSecond ?? 0,
			globalMaxFirewalls: config.globalMaxFirewalls ?? 0,
			globalMaxConcurrentExecutions: config.globalMaxConcurrentExecutions ?? 0,
		};
	}

	/** Check if a new request is allowed under the per-principal rate limit. */
	checkRequestRate(principalId: string): { allowed: boolean; retryAfterMs?: number } {
		const limit = this.config.maxRequestsPerSecond;
		if (limit <= 0) return { allowed: true };

		const now = monotonicNow();
		const windowStart = now - 1000;
		let timestamps = this.requestWindows.get(principalId);
		if (!timestamps) {
			timestamps = [];
			this.requestWindows.set(principalId, timestamps);
		}

		// Prune expired entries
		const firstValid = timestamps.findIndex((t) => t > windowStart);
		if (firstValid > 0) timestamps.splice(0, firstValid);
		else if (firstValid === -1) timestamps.length = 0;

		if (timestamps.length >= limit) {
			const oldestInWindow = timestamps[0]!;
			const retryAfterMs = oldestInWindow + 1000 - now;
			return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
		}

		timestamps.push(monotonicNow());
		return { allowed: true };
	}

	/** Check if a new concurrent execution is allowed. Returns false if at limit. */
	checkConcurrency(principalId: string): boolean {
		const perPrincipal = this.config.maxConcurrentExecutions;
		if (perPrincipal > 0) {
			const current = this.concurrentExecs.get(principalId) ?? 0;
			if (current >= perPrincipal) return false;
		}

		const global = this.config.globalMaxConcurrentExecutions;
		if (global > 0 && this.globalConcurrent >= global) return false;

		return true;
	}

	/** Acquire a concurrency slot. Call release() when done. */
	acquire(principalId: string): void {
		this.concurrentExecs.set(principalId, (this.concurrentExecs.get(principalId) ?? 0) + 1);
		this.globalConcurrent++;
	}

	/** Release a concurrency slot. */
	release(principalId: string): void {
		const current = this.concurrentExecs.get(principalId) ?? 0;
		if (current > 0) this.concurrentExecs.set(principalId, current - 1);
		else this.concurrentExecs.delete(principalId); // Clean up zero entries
		if (this.globalConcurrent > 0) this.globalConcurrent--;
	}

	/**
	 * Recalculate globalConcurrent from the sum of individual entries.
	 * Guards against counter drift from unexpected error paths that may
	 * skip release(). Safe to call periodically or after error recovery.
	 */
	reconcileGlobalConcurrent(): void {
		let sum = 0;
		const toDelete: string[] = [];
		this.concurrentExecs.forEach((count, key) => {
			if (count <= 0) {
				toDelete.push(key);
			} else {
				sum += count;
			}
		});
		for (const key of toDelete) {
			this.concurrentExecs.delete(key);
		}
		this.globalConcurrent = sum;
	}

	/** Check firewall count limits. */
	checkFirewallLimit(principalFirewallCount: number, totalFirewallCount: number): boolean {
		const perPrincipal = this.config.maxFirewallsPerPrincipal;
		if (perPrincipal > 0 && principalFirewallCount >= perPrincipal) return false;

		const global = this.config.globalMaxFirewalls;
		if (global > 0 && totalFirewallCount >= global) return false;

		return true;
	}

	/** Whether any rate limits are configured. */
	get enabled(): boolean {
		return (
			this.config.maxFirewallsPerPrincipal > 0 ||
			this.config.maxConcurrentExecutions > 0 ||
			this.config.maxRequestsPerSecond > 0 ||
			this.config.globalMaxFirewalls > 0 ||
			this.config.globalMaxConcurrentExecutions > 0
		);
	}
}
