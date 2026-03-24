/**
 * AriKernel Integration for Secret Agent X
 *
 * Runs AriKernel as a sidecar process on port 8787.
 * Every tool call routes through the kernel for:
 * - Capability-based access control
 * - Taint tracking (web content → file read → http post detection)
 * - Behavioral sequence detection (multi-step attack blocking)
 * - Run-level quarantine
 * - Tamper-evident audit log
 */

import { createKernel, createFirewall } from "@arikernel/runtime";
import type { Firewall } from "@arikernel/runtime";

const ARI_PORT = parseInt(process.env.ARI_KERNEL_PORT || "8787", 10);
const ARI_BASE_URL = `http://127.0.0.1:${ARI_PORT}`;

let firewall: Firewall | null = null;
let sidecarProcess: ReturnType<typeof import("node:child_process").spawn> | null = null;
let currentPreset: string = "workspace-assistant";

// Map session policy presets to ARI presets
const SESSION_TO_ARI_PRESET: Record<string, string> = {
  "default": "workspace-assistant",
  "high-security": "strict",
  "dev-mode": "research",
  "read-only": "safe",
};

export function getAriPresetForSession(sessionPreset: string): string {
  return SESSION_TO_ARI_PRESET[sessionPreset] || "workspace-assistant";
}

/**
 * Start the AriKernel sidecar process.
 * Returns true if started successfully, false if unavailable.
 */
export async function startAriKernel(auditDbPath: string, preset?: string): Promise<boolean> {
  currentPreset = preset || "workspace-assistant";
  // Try embedded mode first (no sidecar needed)
  try {
    const kernel = createKernel({
      preset: currentPreset as any,
      autoScope: true,
    });

    firewall = kernel.createFirewall({
      principal: "secret-agent-x",
      auditLog: auditDbPath,
    });

    console.log(`  [ari] Kernel initialized (embedded mode, preset: ${currentPreset})`);
    return true;
  } catch (e) {
    console.warn(`  [ari] Embedded mode failed, trying sidecar: ${(e as Error).message}`);
  }

  // Fallback: try connecting to existing sidecar
  try {
    const health = await fetch(`${ARI_BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (health.ok) {
      const kernel = createKernel({
        preset: "workspace-assistant",
        mode: "sidecar",
        sidecar: { baseUrl: ARI_BASE_URL, principalId: "secret-agent-x" },
      });
      firewall = kernel.createFirewall({
        principal: "secret-agent-x",
        auditLog: auditDbPath,
      });
      console.log(`  [ari] Connected to existing sidecar at ${ARI_BASE_URL}`);
      return true;
    }
  } catch {
    // Sidecar not running — that's OK
  }

  console.log(`  [ari] Kernel not available — running without AriKernel (built-in security still active)`);
  return false;
}

/**
 * Evaluate a tool call through AriKernel.
 * Returns { allowed, reason } — same shape as SecurityLayer.evaluate().
 */
export async function ariEvaluate(
  toolName: string,
  action: string,
  params: Record<string, unknown>,
  taintLabels?: string[]
): Promise<{ allowed: boolean; reason: string; quarantined?: boolean }> {
  if (!firewall) {
    return { allowed: true, reason: "AriKernel not active" };
  }

  // Map our tool names to AriKernel tool classes
  const toolClassMap: Record<string, string> = {
    bash: "shell",
    read: "file",
    write: "file",
    edit: "file",
    browser: "http",
    http_request: "http",
    web_fetch: "http",
    memory_search: "retrieval",
    memory_save: "database",
  };

  const toolClass = toolClassMap[toolName] || "shell";

  try {
    const result = await firewall.execute({
      toolClass: toolClass as any,
      action,
      parameters: params,
      taintLabels: taintLabels?.map(label => ({
        source: label as any,
        origin: "agent",
        confidence: 1.0,
        addedAt: new Date().toISOString(),
      })),
    });

    if (!result.success) {
      return {
        allowed: false,
        reason: `[ARI] ${result.error || "Denied by kernel policy"}`,
      };
    }

    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    // AriKernel error — fail open with warning (built-in security still applies)
    console.warn(`[ari] Evaluation error: ${(e as Error).message}`);
    return { allowed: true, reason: "ARI error (fail-open, built-in security active)" };
  }
}

/**
 * Get AriKernel status for the current run.
 */
export async function ariStatus(): Promise<Record<string, unknown> | null> {
  if (!firewall) return null;

  try {
    return (firewall as any).status?.() || { active: true, mode: "embedded" };
  } catch {
    return { active: true, mode: "unknown" };
  }
}

/**
 * Check if AriKernel is active.
 */
export function isAriActive(): boolean {
  return firewall !== null;
}

/**
 * Stop the sidecar process.
 */
export function stopAriKernel(): void {
  if (sidecarProcess) {
    sidecarProcess.kill();
    sidecarProcess = null;
  }
  firewall = null;
}
