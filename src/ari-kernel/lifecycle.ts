// AriKernel lifecycle — start / stop / status / test accessor.
//
// startAriKernel: build firewall, mint host grants, register no-op
// executors so the kernel doesn't try to perform the action itself.
// stopAriKernel: close firewall, reset state.

import { getPreset } from "@arikernel/core";
import type { PresetId } from "@arikernel/core";
import { TokenStore, createFirewall } from "@arikernel/runtime";
import type { Firewall, FirewallHooks } from "@arikernel/runtime";

import { createLogger } from "../logger.js";
import { getAuditHmacKey } from "../app-runtime/audit-signing.js";
import {
  getFirewall, setFirewall,
  setTokenStore,
  setHostGrants,
  getCurrentPreset, setCurrentPreset,
  getAriAuditDbPath, setAriAuditDbPath,
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
  auditDbPath: string,
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
  // Provision the audit-chain HMAC key via the SAME mechanism token signing
  // uses (per-install <laxDir>/audit-key, 0600, or LAX_AUDIT_KEY override).
  // Threading it in upgrades the audit hash chain from plain SHA-256 (any file
  // writer can forge) to HMAC-SHA256 (must extract the in-process key). Honest
  // limit: a full kernel-process compromise can still read this key from memory.
  const auditHmacKeyRaw = getAuditHmacKey();
  const auditHmacKey = Buffer.isBuffer(auditHmacKeyRaw)
    ? auditHmacKeyRaw
    : Buffer.from(auditHmacKeyRaw);
  const firewall = createFirewall({
    principal: {
      name: HOST_PRINCIPAL_NAME,
      capabilities: buildPrincipalCapabilities(),
    },
    policies: presetConfig.policies,
    auditLog: auditDbPath,
    mode: "embedded",
    tokenStore,
    hooks,
    auditHmacKey,
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
    const { firewall, tokenStore, grants } = buildAriFirewall(auditDbPath, resolvedPreset);
    setTokenStore(tokenStore);
    setFirewall(firewall);
    setHostGrants(grants);
    // Remember the path so a per-op refresh can rebuild an identical firewall.
    setAriAuditDbPath(auditDbPath);
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
 * Rebuild the singleton firewall to start a FRESH ARI run — the runtime's
 * run-state (restricted mode, quarantine, denied-action counters, run-level
 * taint) is created once per Firewall and has no in-place reset, so a new run
 * means a new Firewall. Build the replacement FIRST, then publish it, then
 * close the old one: no window where getFirewall() is null (which ariRequired
 * would hard-block). Returns false (and keeps the current firewall) if the
 * kernel isn't active or the rebuild throws.
 */
export function refreshAriKernelRun(): boolean {
  const old = getFirewall();
  const auditDbPath = getAriAuditDbPath();
  if (!old || !auditDbPath) return false;
  try {
    const { firewall, tokenStore, grants } = buildAriFirewall(auditDbPath, getCurrentPreset());
    // Atomic swap (synchronous — no await between build and publish).
    setTokenStore(tokenStore);
    setFirewall(firewall);
    setHostGrants(grants);
    try {
      (old as unknown as { close?: () => void }).close?.();
    } catch {
      /* old run's in-flight denials may race close(); the new firewall is live regardless */
    }
    logger.info(`  [ari] Run refreshed — fresh run-state (restricted/quarantine/denied-action counters cleared)`);
    return true;
  } catch (e) {
    logger.warn(`  [ari] Run refresh failed, keeping current firewall: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Op-boundary guard: if the singleton firewall is stuck in restricted or
 * quarantine mode from a PRIOR op, refresh the run so the new op starts clean.
 * The runtime designed those escalations to be per-run; LAX runs one firewall
 * for the whole process, so without this a single tripped guard bricks every
 * later op into read-only until restart. No-op (returns false) when healthy.
 */
export function refreshAriKernelRunIfStuck(): boolean {
  const fw = getFirewall() as (Firewall & { isRestricted?: boolean; quarantineInfo?: unknown }) | null;
  if (!fw) return false;
  const restricted = fw.isRestricted === true;
  const quarantined = fw.quarantineInfo != null;
  if (!restricted && !quarantined) return false;
  logger.warn(`  [ari] Firewall in ${restricted ? "restricted" : "quarantine"} mode at op start — refreshing run so a prior op's escalation doesn't brick this one`);
  return refreshAriKernelRun();
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
export function getFirewallForTest(): Firewall | null {
  return getFirewall();
}

export function stopAriKernel(): void {
  try {
    const fw = getFirewall();
    (fw as unknown as { close?: () => void } | null)?.close?.();
  } catch {
    /* ignore */
  }
  setFirewall(null);
  setTokenStore(null);
  setHostGrants(new Map());
  setAriAuditDbPath(null);
}
