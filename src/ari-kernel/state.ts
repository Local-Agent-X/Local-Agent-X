// Process-level AriKernel registry. Each canonical operation receives its own
// Firewall (and therefore its own sticky run-state), while every scope shares
// one process-owned AuditStore. The default scope serves non-op/ad-hoc calls.

import type { Firewall, TokenStore } from "@arikernel/runtime";
import type { AuditStore } from "@arikernel/audit-log";
import type { CapabilityClass } from "@arikernel/core";

export const DEFAULT_ARI_SCOPE = "__default__";

export interface AriScopeState {
  firewall: Firewall;
  tokenStore: TokenStore;
  grants: Map<CapabilityClass, string>;
}

const scopes = new Map<string, AriScopeState>();
let sharedAuditStore: AuditStore | null = null;
let currentPreset: string = "workspace-assistant";
// Default true so the deepest gate is load-bearing even if a caller forgets
// to pass `required`. The config layer (src/config.ts: ariRequired) is the
// canonical source — this is just the safety net.
let ariIsRequired: boolean = true;

export function getFirewall(scopeId = DEFAULT_ARI_SCOPE): Firewall | null {
  return scopes.get(scopeId)?.firewall ?? null;
}

export function getTokenStore(scopeId = DEFAULT_ARI_SCOPE): TokenStore | null {
  return scopes.get(scopeId)?.tokenStore ?? null;
}

export function getHostGrants(scopeId = DEFAULT_ARI_SCOPE): Map<CapabilityClass, string> {
  return scopes.get(scopeId)?.grants ?? new Map();
}

export function getAriScope(scopeId: string): AriScopeState | null {
  return scopes.get(scopeId) ?? null;
}
export function setAriScope(scopeId: string, state: AriScopeState): void {
  scopes.set(scopeId, state);
}
export function deleteAriScope(scopeId: string): AriScopeState | null {
  const state = scopes.get(scopeId) ?? null;
  scopes.delete(scopeId);
  return state;
}
export function listAriScopes(): Array<[string, AriScopeState]> {
  return [...scopes.entries()];
}
export function clearAriScopes(): void { scopes.clear(); }

export function getSharedAuditStore(): AuditStore | null { return sharedAuditStore; }
export function setSharedAuditStore(store: AuditStore | null): void { sharedAuditStore = store; }

export function getCurrentPreset(): string { return currentPreset; }
export function setCurrentPreset(p: string): void { currentPreset = p; }

export function isAriRequired(): boolean { return ariIsRequired; }
export function setAriRequired(b: boolean): void { ariIsRequired = b; }

// Public — used by routes/security and tool-execution to check kernel
// activation without exposing the firewall reference itself.
export function isAriActive(): boolean { return scopes.size > 0; }

// Test-only accessor for the live Firewall. Production code MUST NOT
// read this — use ariEvaluate / ariObserve so the call shape stays
// uniform across paths.
export function getFirewallForTest(scopeId = DEFAULT_ARI_SCOPE): Firewall | null { return getFirewall(scopeId); }
