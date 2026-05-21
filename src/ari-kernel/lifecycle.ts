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
import {
  getFirewall, setFirewall,
  setTokenStore,
  setHostGrants,
  setCurrentPreset,
  setAriRequired, isAriRequired,
} from "./state.js";
import { HOST_CAPABILITY_MANIFEST, buildPrincipalCapabilities } from "./manifest.js";
import { mintHostGrants } from "./grants.js";

const logger = createLogger("ari-kernel");

const HOST_PRINCIPAL_NAME = "lax-host";

export async function startAriKernel(auditDbPath: string, preset?: string, required?: boolean): Promise<boolean> {
  const resolvedPreset = preset || "workspace-assistant";
  setCurrentPreset(resolvedPreset);
  setAriRequired(required ?? true);

  try {
    const presetConfig = getPreset(resolvedPreset as PresetId);
    const tokenStore = new TokenStore();
    setTokenStore(tokenStore);
    // Approval is owned by LAX's user-facing layer (riskLevel → UI prompt
    // in the require-approval phase). The kernel's approval hook would
    // otherwise double-prompt or — without a hook — deny outright. Delegate
    // by returning true; deny / taint / capability layers all still fire
    // before the approval hook is ever called.
    const hooks: FirewallHooks = {
      onApprovalRequired: async () => true,
    };
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
    });
    setFirewall(firewall);

    // Manifest-driven grant issuance — runs exactly once, right after
    // firewall construction. The per-call rule engine still evaluates
    // every tool call on top of these grants.
    const grants = mintHostGrants(tokenStore, firewall.principalInfo.id);
    setHostGrants(grants);
    logger.info(`  [ari] Granted ${grants.size} host capabilities (manifest entries: ${HOST_CAPABILITY_MANIFEST.length})`);

    // Register no-op executors for every toolClass in the manifest. ARI's
    // role is observer + gate; the real tool logic runs in LAX's own
    // dispatcher AFTER ariEvaluate returns allowed. Without these stubs,
    // the kernel would try to perform the action itself via its built-in
    // executors and either fail (path-traversal-blocked on /etc/hostname)
    // or duplicate the side-effect of the real tool call.
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
}
