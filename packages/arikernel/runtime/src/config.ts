import type { Capability, PolicyRule, SigningKey } from "@arikernel/core";
import { firewallConfigSchema } from "@arikernel/core";
import type { FirewallHooks } from "./hooks.js";
import type { RunStatePolicy } from "./run-state.js";
import type { AuditStore } from "@arikernel/audit-log";

/**
 * Security mode controls capability token signing requirements.
 * - 'dev': tokens are required for protected actions but NOT cryptographically signed
 *   (no signing key needed; grants are still enforced via the token store)
 * - 'secure': tokens are required and must be cryptographically signed
 *
 * In both modes, protected actions (writes, shell exec, etc.) require a valid
 * capability grant obtained via requestCapability(). The difference is whether
 * grants are cryptographically signed (secure) or unsigned (dev).
 */
export type SecurityMode = "dev" | "secure";

export interface FirewallOptions {
	principal: {
		name: string;
		capabilities: Capability[];
	};
	policies: string | PolicyRule[];
	auditLog?: string;
	/**
	 * Optional process-owned audit store. Scoped firewalls may share one store
	 * so concurrent runs append to one hash chain. The firewall will end its
	 * run on close but will not close an injected store.
	 */
	auditStore?: AuditStore;
	hooks?: FirewallHooks;
	runStatePolicy?: RunStatePolicy;
	/** Optional signing key for cryptographically signed capability tokens. */
	signingKey?: SigningKey;
	/**
	 * Optional HMAC key for the tamper-evident audit hash chain. When provided,
	 * each chain hash is an HMAC-SHA256 keyed digest instead of a plain SHA-256,
	 * so an attacker with filesystem (SQLite) access cannot recompute a valid
	 * chain without the key. The host (LAX) provisions a persistent per-install
	 * key and passes it here. Honest limit: this raises the bar from "any file
	 * writer can forge the chain" to "must extract the in-process key" — it does
	 * not make the log non-repudiable against a full kernel-process compromise,
	 * since the key lives in memory while the kernel runs.
	 */
	auditHmacKey?: Buffer;
	/**
	 * Security mode. Default: 'dev' if no signingKey, 'secure' if signingKey is provided.
	 * In 'secure' mode, capability grants must be cryptographically signed.
	 * In 'dev' mode, grants are still required for protected actions but are unsigned.
	 */
	securityMode?: SecurityMode;
	/**
	 * Optional external token store. When provided, the firewall uses this
	 * store instead of the default in-memory TokenStore.
	 */
	tokenStore?: import("./token-store.js").ITokenStore;
}

export function validateOptions(options: FirewallOptions): FirewallOptions {
	firewallConfigSchema.parse({
		principal: options.principal,
		policies: options.policies,
		auditLog: options.auditLog ?? "./audit.db",
	});
	return options;
}
