/**
 * AriKernel Integration for Open Agent X
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

  // Priority 1: Sidecar mode (secure — separate process, can't be bypassed by compromised agent)
  try {
    const health = await fetch(`${ARI_BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (health.ok) {
      const kernel = createKernel({
        preset: currentPreset as any,
        mode: "sidecar",
        sidecar: { baseUrl: ARI_BASE_URL, principalId: "open-agent-x" },
      });
      firewall = kernel.createFirewall({
        principal: "open-agent-x",
        auditLog: auditDbPath,
      });
      console.log(`  [ari] Kernel initialized (SIDECAR mode, preset: ${currentPreset})`);
      console.log(`  [ari] Sidecar: ${ARI_BASE_URL}`);
      return true;
    }
  } catch {
    // Sidecar not running — fall through to embedded
  }

  // Priority 2: Start sidecar process from ARI Kernel project
  try {
    const { spawn: spawnProcess } = await import("node:child_process");
    const { existsSync: ex } = await import("node:fs");
    const { join: j, resolve: res } = await import("node:path");
    const { homedir: hd } = await import("node:os");

    // Look for ARI Kernel CLI: npm package first, then local project
    const ariCliPaths = [
      // From npm (installed via: npm install @arikernel/cli)
      j(res("."), "node_modules", "@arikernel", "cli", "dist", "main.js"),
      // Local project (development)
      j(hd(), "Ari Kernel", "apps", "cli", "dist", "main.js"),
      j(res("."), "..", "Ari Kernel", "apps", "cli", "dist", "main.js"),
      j(hd(), "ari-kernel", "apps", "cli", "dist", "main.js"),
    ];
    const ariCli = ariCliPaths.find(p => ex(p));

    if (ariCli) {
      console.log(`  [ari] Starting sidecar from ${ariCli}...`);
      sidecarProcess = spawnProcess("node", [
        ariCli, "sidecar",
        "--port", String(ARI_PORT),
        "--host", "127.0.0.1",
        "--audit-log", auditDbPath,
      ], { stdio: "ignore", detached: false, windowsHide: true });

      sidecarProcess.on("error", () => { sidecarProcess = null; });

      // Wait for sidecar to be ready
      await new Promise(resolve => setTimeout(resolve, 2500));
      const health = await fetch(`${ARI_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (health.ok) {
        const kernel = createKernel({
          preset: currentPreset as any,
          mode: "sidecar",
          sidecar: { baseUrl: ARI_BASE_URL, principalId: "open-agent-x" },
        });
        firewall = kernel.createFirewall({
          principal: "open-agent-x",
          auditLog: auditDbPath,
        });
        console.log(`  [ari] Kernel initialized (SIDECAR mode, preset: ${currentPreset})`);
        console.log(`  [ari] Sidecar: ${ARI_BASE_URL}`);
        return true;
      }
    }
  } catch {
    // Sidecar start failed — fall through to embedded
    if (sidecarProcess) { try { sidecarProcess.kill(); } catch {} sidecarProcess = null; }
  }

  // Priority 3: Embedded mode (explicitly set to suppress "defaulting to embedded" warning)
  try {
    const kernel = createKernel({
      preset: currentPreset as any,
      mode: "embedded",
      autoScope: true,
    });
    firewall = kernel.createFirewall({
      principal: "open-agent-x",
      auditLog: auditDbPath,
    });
    console.log(`[AriKernel] Running in EMBEDDED mode. For production security, install and run arikernel-sidecar.`);
    console.log(`  [ari] Kernel initialized (embedded mode, preset: ${currentPreset})`);
    return true;
  } catch (e) {
    console.warn(`  [ari] Embedded mode failed: ${(e as Error).message}`);
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
    const execRequest: Record<string, unknown> = {
      toolClass: toolClass as any,
      action,
      parameters: params,
    };
    // Only include taintLabels when actually present — the sidecar's Zod schema
    // is strict about TaintLabel format and will 500 on validation failures
    if (taintLabels && taintLabels.length > 0) {
      execRequest.taintLabels = taintLabels.map(label => ({
        source: String(label),
        origin: "agent" as const,
        confidence: 1.0,
        addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), // Strip milliseconds for strict datetime()
      }));
    }
    const result = await firewall.execute(execRequest as any);

    if (!result.success) {
      return {
        allowed: false,
        reason: `[ARI] ${result.error || "Denied by kernel policy"}`,
      };
    }

    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    // AriKernel error — fail open silently (built-in SecurityLayer still applies)
    // Don't log every evaluation error — it's noisy and the tool runs anyway
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
