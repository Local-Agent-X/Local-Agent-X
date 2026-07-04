// AriKernel lifecycle — shared audit ownership + operation-scoped firewalls.
//
// startAriKernel: build firewall, mint host grants, register no-op
// executors so the kernel doesn't try to perform the action itself.
// stopAriKernel: close firewall, reset state.

import { getPreset } from "@arikernel/core";
import type { PresetId } from "@arikernel/core";
import { TokenStore, createFirewall } from "@arikernel/runtime";
import type { Firewall, FirewallHooks } from "@arikernel/runtime";
import { AuditStore } from "@arikernel/audit-log";

import { createLogger } from "../logger.js";
import { getAuditHmacKey } from "../app-runtime/audit-signing.js";
import {
  DEFAULT_ARI_SCOPE,
  getFirewall,
  getAriScope, setAriScope, deleteAriScope, listAriScopes, clearAriScopes,
  getSharedAuditStore, setSharedAuditStore,
  getCurrentPreset, setCurrentPreset,
  setAriRequired, isAriRequired,
} from "./state.js";
import { HOST_CAPABILITY_MANIFEST, buildPrincipalCapabilities } from "./manifest.js";
import { mintHostGrants } from "./grants.js";

const logger = createLogger("ari-kernel");

const HOST_PRINCIPAL_NAME = "lax-host";

/**
 * Build a fresh Firewall + host grants for a preset. Pure w.r.t. global kernel
 * state (sets nothing) so it serves BOTH first-time startup and a per-op run
 * refresh — the caller decides when to publish the result. Synchronous: every
 * step (getPreset / createFirewall / mintHostGrants) is sync, which is what lets
 * refreshAriKernelRun swap the firewall atomically with no await in between.
 */
function buildAriFirewall(
  auditStore: AuditStore,
  preset: string,
): { firewall: Firewall; tokenStore: TokenStore; grants: ReturnType<typeof mintHostGrants> } {
  const presetConfig = getPreset(preset as PresetId);
  const tokenStore = new TokenStore();
  // Approval is owned by LAX's user-facing layer (riskLevel → UI prompt in the
  // require-approval phase). The kernel's approval hook would otherwise
  // double-prompt or — without a hook — deny outright. Delegate by returning
  // true; deny / taint / capability layers all still fire before it's called.
  const hooks: FirewallHooks = {
    onApprovalRequired: async () => true,
  };
  const firewall = createFirewall({
    principal: {
      name: HOST_PRINCIPAL_NAME,
      capabilities: buildPrincipalCapabilities(),
    },
    policies: presetConfig.policies,
    auditStore,
    mode: "embedded",
    tokenStore,
    hooks,
  });

  // Manifest-driven grant issuance — the per-call rule engine still evaluates
  // every tool call on top of these grants.
  const grants = mintHostGrants(tokenStore, firewall.principalInfo.id);

  // Register no-op executors for every toolClass in the manifest. ARI's role is
  // observer + gate; the real tool logic runs in LAX's own dispatcher AFTER
  // ariEvaluate returns allowed. Without these stubs the kernel would try to
  // perform the action itself and either fail (path-traversal-blocked on
  // /etc/hostname) or duplicate the real tool call's side-effect.
  const noopRegister = (firewall as unknown as {
    registerExecutor: (e: {
      toolClass: string;
      execute: (tc: { id: string }) => Promise<{
        callId: string;
        success: boolean;
        durationMs: number;
        taintLabels: never[];
      }>;
    }) => void;
  }).registerExecutor.bind(firewall);
  const noopExec = async (tc: { id: string }) => ({
    callId: tc.id,
    success: true,
    durationMs: 0,
    taintLabels: [] as never[],
  });
  const gatedClasses = new Set<string>();
  for (const { toolClass } of HOST_CAPABILITY_MANIFEST) gatedClasses.add(toolClass);
  for (const toolClass of gatedClasses) {
    try {
      noopRegister({ toolClass, execute: noopExec });
    } catch (e) {
      logger.warn(`[ari] ${toolClass} executor registration failed: ${(e as Error).message}`);
    }
  }

  return { firewall, tokenStore, grants };
}

export async function startAriKernel(auditDbPath: string, preset?: string, required?: boolean): Promise<boolean> {
  const resolvedPreset = preset || "workspace-assistant";
  setCurrentPreset(resolvedPreset);
  setAriRequired(required ?? true);

  try {
    const auditHmacKeyRaw = getAuditHmacKey();
    const auditHmacKey = Buffer.isBuffer(auditHmacKeyRaw)
      ? auditHmacKeyRaw
      : Buffer.from(auditHmacKeyRaw);
    const auditStore = new AuditStore(auditDbPath, auditHmacKey);
    const { firewall, tokenStore, grants } = buildAriFirewall(auditStore, resolvedPreset);
    setSharedAuditStore(auditStore);
    setAriScope(DEFAULT_ARI_SCOPE, { firewall, tokenStore, grants });
    logger.info(`  [ari] Granted ${grants.size} host capabilities (manifest entries: ${HOST_CAPABILITY_MANIFEST.length})`);
    logger.info(`  [ari] Kernel initialized (in-process, preset: ${resolvedPreset})`);
    return true;
  } catch (e) {
    logger.warn(`  [ari] Init failed: ${(e as Error).message}`);
    if (isAriRequired()) {
      logger.error(`  [ari] CRITICAL: AriKernel required but failed to start`);
    }
    return false;
  }
}

/**
 * Rebuild the default firewall to start a fresh ARI run — the runtime's
 * run-state (restricted mode, quarantine, denied-action counters, run-level
 * taint) is created once per Firewall and has no in-place reset, so a new run
 * means a new Firewall. Build the replacement first, then publish it, then
 * close the old scope so evaluation never observes a missing firewall.
 */
export function refreshAriKernelRun(): boolean {
  return refreshAriKernelScope(DEFAULT_ARI_SCOPE);
}

export function ensureAriKernelScope(scopeId?: string): Firewall | null {
  const resolvedScope = scopeId || DEFAULT_ARI_SCOPE;
  const existing = getAriScope(resolvedScope);
  if (existing) return existing.firewall;
  const auditStore = getSharedAuditStore();
  if (!auditStore) return null;
  try {
    const built = buildAriFirewall(auditStore, getCurrentPreset());
    setAriScope(resolvedScope, built);
    logger.info(`  [ari] Scope started: ${resolvedScope}`);
    return built.firewall;
  } catch (e) {
    logger.warn(`  [ari] Scope start failed (${resolvedScope}): ${(e as Error).message}`);
    return null;
  }
}

export function refreshAriKernelScope(scopeId?: string): boolean {
  const resolvedScope = scopeId || DEFAULT_ARI_SCOPE;
  const old = getAriScope(resolvedScope);
  const auditStore = getSharedAuditStore();
  if (!old || !auditStore) return false;
  try {
    const replacement = buildAriFirewall(auditStore, getCurrentPreset());
    setAriScope(resolvedScope, replacement);
    try {
      old.firewall.close();
    } catch {
      /* replacement is already live */
    }
    logger.info(`  [ari] Scope refreshed (${resolvedScope}) — run-state cleared`);
    return true;
  } catch (e) {
    logger.warn(`  [ari] Run refresh failed, keeping current firewall: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Compatibility guard for the default/ad-hoc scope. Canonical operations use
 * dedicated scopes and do not need cross-op refresh.
 */
export function refreshAriKernelRunIfStuck(): boolean {
  return refreshAriKernelScopeIfStuck(DEFAULT_ARI_SCOPE);
}

export function refreshAriKernelScopeIfStuck(scopeId?: string): boolean {
  const resolvedScope = scopeId || DEFAULT_ARI_SCOPE;
  const fw = getFirewall(resolvedScope) as (Firewall & { isRestricted?: boolean; quarantineInfo?: unknown }) | null;
  if (!fw) return false;
  const restricted = fw.isRestricted === true;
  const quarantined = fw.quarantineInfo != null;
  if (!restricted && !quarantined) return false;
  logger.warn(`  [ari] Firewall in ${restricted ? "restricted" : "quarantine"} mode at op start — refreshing run so a prior op's escalation doesn't brick this one`);
  return refreshAriKernelScope(resolvedScope);
}

// Get AriKernel status for the current run.
export async function ariStatus(): Promise<Record<string, unknown> | null> {
  const firewall = getFirewall();
  if (!firewall) return null;
  try {
    return (firewall as unknown as { status?: () => Record<string, unknown> }).status?.() || { active: true, mode: "in-process" };
  } catch {
    return { active: true, mode: "in-process" };
  }
}

// Test-only accessor for the live Firewall. Production code MUST NOT
// read this — use ariEvaluate / ariObserve so the call shape stays
// uniform across paths.
export function getFirewallForTest(scopeId?: string): Firewall | null {
  return getFirewall(scopeId);
}

export function releaseAriKernelScope(scopeId?: string): boolean {
  const resolvedScope = scopeId || DEFAULT_ARI_SCOPE;
  if (resolvedScope === DEFAULT_ARI_SCOPE) return false;
  const state = deleteAriScope(resolvedScope);
  if (!state) return false;
  try { state.firewall.close(); } catch { /* best effort during op cleanup */ }
  logger.info(`  [ari] Scope released: ${resolvedScope}`);
  return true;
}

export function stopAriKernel(): void {
  for (const [, scope] of listAriScopes()) {
    try { scope.firewall.close(); } catch { /* ignore */ }
  }
  clearAriScopes();
  try { getSharedAuditStore()?.close(); } catch { /* ignore */ }
  setSharedAuditStore(null);
}
