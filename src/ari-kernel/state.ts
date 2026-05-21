// Singleton state for the in-process AriKernel. Set once at startup by
// lifecycle.startAriKernel; read across observe/evaluate/coverage; reset
// by stopAriKernel. Accessor functions are the seam — keeps the
// firewall reference behind a clear get/set boundary so each phase
// module doesn't reach into another module's mutable state.

import type { Firewall, TokenStore } from "@arikernel/runtime";
import type { CapabilityClass } from "@arikernel/core";

let firewall: Firewall | null = null;
let hostTokenStore: TokenStore | null = null;
let hostGrantsByCapClass: Map<CapabilityClass, string> = new Map();
let currentPreset: string = "workspace-assistant";
// Default true so the deepest gate is load-bearing even if a caller forgets
// to pass `required`. The config layer (src/config.ts: ariRequired) is the
// canonical source — this is just the safety net.
let ariIsRequired: boolean = true;

export function getFirewall(): Firewall | null { return firewall; }
export function setFirewall(f: Firewall | null): void { firewall = f; }

export function getTokenStore(): TokenStore | null { return hostTokenStore; }
export function setTokenStore(t: TokenStore | null): void { hostTokenStore = t; }

export function getHostGrants(): Map<CapabilityClass, string> { return hostGrantsByCapClass; }
export function setHostGrants(m: Map<CapabilityClass, string>): void { hostGrantsByCapClass = m; }

export function getCurrentPreset(): string { return currentPreset; }
export function setCurrentPreset(p: string): void { currentPreset = p; }

export function isAriRequired(): boolean { return ariIsRequired; }
export function setAriRequired(b: boolean): void { ariIsRequired = b; }

// Public — used by routes/security and tool-execution to check kernel
// activation without exposing the firewall reference itself.
export function isAriActive(): boolean { return firewall !== null; }

// Test-only accessor for the live Firewall. Production code MUST NOT
// read this — use ariEvaluate / ariObserve so the call shape stays
// uniform across paths.
export function getFirewallForTest(): Firewall | null { return firewall; }
