/**
 * AriKernel Integration for Local Agent X (in-process)
 *
 * Every tool call routes through the kernel for:
 * - Capability-based access control
 * - Taint tracking (web content → file read → http post detection)
 * - Behavioral sequence detection (multi-step attack blocking)
 * - Run-level quarantine
 * - Tamper-evident audit log
 */

import { createKernel } from "@arikernel/runtime";
import type { Firewall } from "@arikernel/runtime";

import { createLogger } from "./logger.js";
import { USER_HINTS } from "./types.js";
const logger = createLogger("ari-kernel");

let firewall: Firewall | null = null;
let currentPreset: string = "workspace-assistant";
let ariIsRequired: boolean = false;

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
 * Initialize AriKernel in-process.
 * Returns true if started successfully, false if unavailable.
 */
export async function startAriKernel(auditDbPath: string, preset?: string, required?: boolean): Promise<boolean> {
  currentPreset = preset || "workspace-assistant";
  ariIsRequired = required ?? false;

  try {
    const kernel = createKernel({
      preset: currentPreset as any,
      mode: "embedded",
      autoScope: true,
    });
    firewall = kernel.createFirewall({
      principal: "local-agent-x",
      auditLog: auditDbPath,
    });

    // Register a no-op executor for `secret-vault` so the ARI pipeline can
    // complete its audit/policy/behavioral steps without trying to actually
    // run the tool. The real secret-vault logic (DOM read, vault write, page
    // fill, clipboard write) lives in the tool's own execute() and runs
    // AFTER ariEvaluate returns allowed. ARI's role here is observer + gate.
    try {
      (firewall as unknown as { registerExecutor: (e: { toolClass: string; execute: (tc: { id: string }) => Promise<{ callId: string; success: boolean; durationMs: number; taintLabels: never[] }> }) => void }).registerExecutor({
        toolClass: "secret-vault",
        async execute(tc) {
          return {
            callId: tc.id,
            success: true,
            durationMs: 0,
            taintLabels: [],
          };
        },
      });
    } catch (e) {
      logger.warn(`[ari] secret-vault executor registration failed: ${(e as Error).message}`);
    }

    logger.info(`  [ari] Kernel initialized (in-process, preset: ${currentPreset})`);
    return true;
  } catch (e) {
    logger.warn(`  [ari] Init failed: ${(e as Error).message}`);
    if (ariIsRequired) {
      logger.error(`  [ari] CRITICAL: AriKernel required but failed to start`);
    }
    return false;
  }
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
): Promise<{ allowed: boolean; reason: string; quarantined?: boolean; userHint?: string }> {
  if (!firewall) {
    if (ariIsRequired) {
      return { allowed: false, reason: "AriKernel required but not active — tool call blocked", userHint: USER_HINTS.policy };
    }
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
    web_search: "http",
    memory_search: "retrieval",
    memory_save: "database",
    // Internal tools — always allowed
    agent_spawn: "internal",
    agent_redirect: "internal",
    agent_pause: "internal",
    agent_resume: "internal",
    agent_cancel: "internal",
    agent_status: "internal",
    agent_output: "internal",
    agent_message: "internal",
    delegate: "internal",
    swarm_create: "internal",
    swarm_status: "internal",
    swarm_cancel: "internal",
    swarm_list_roles: "internal",
    swarm_result: "internal",
    mission_list: "internal",
    mission_get: "internal",
    mission_save_preference: "internal",
    mission_format_caption: "internal",
    mission_build: "internal",
    mission_edit: "internal",
    mission_delete: "internal",
    mission_schedule_create: "internal",
    mission_schedule_delete: "internal",
    mission_chain: "internal",
    mission_variables_set: "internal",
    mission_variables_get: "internal",
    playbook_list: "internal",
    playbook_get: "internal",
    generate_image: "internal",
    generate_video: "internal",
    camera_capture: "internal",
    screen_capture: "internal",
    ocr: "internal",
    mission_schedule_list: "internal",
    mission_schedule_update: "internal",
    mission_schedule_toggle: "internal",
    mission_schedule_reports: "internal",
    browser_capture_to_secret: "secret-vault",
    browser_fill_from_secret: "secret-vault",
    clipboard_write_from_secret: "secret-vault",
  };

  // Per-tool action override: secret-vault tools have a fixed action mapping
  // (capture / fill / clipboard) regardless of what the executor passes in.
  // ARI sees the canonical action in audit logs and behavioral rules.
  const secretVaultActionMap: Record<string, string> = {
    browser_capture_to_secret: "capture",
    browser_fill_from_secret: "fill",
    clipboard_write_from_secret: "clipboard",
  };

  const toolClass = toolClassMap[toolName] || "shell";
  const effectiveAction = secretVaultActionMap[toolName] ?? action;

  try {
    const execRequest: Record<string, unknown> = {
      toolClass: toolClass as any,
      action: effectiveAction,
      parameters: params,
    };
    if (taintLabels && taintLabels.length > 0) {
      execRequest.taintLabels = taintLabels.map(label => ({
        source: String(label),
        origin: "agent" as const,
        confidence: 1.0,
        addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }));
    }
    const result = await firewall.execute(execRequest as any);

    if (!result.success) {
      return {
        allowed: false,
        reason: `[ARI] ${result.error || "Denied by kernel policy"}`,
        userHint: USER_HINTS.policy,
      };
    }

    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    if (ariIsRequired) {
      logger.warn(`[ari] Tool call blocked due to ARI error (ariRequired=true): ${(e as Error).message}`);
      return { allowed: false, reason: "ARI error — tool call blocked (ariRequired mode)", userHint: USER_HINTS.policy };
    }
    return { allowed: true, reason: "ARI error (fail-open, built-in security active)" };
  }
}

/**
 * Get AriKernel status for the current run.
 */
export async function ariStatus(): Promise<Record<string, unknown> | null> {
  if (!firewall) return null;

  try {
    return (firewall as any).status?.() || { active: true, mode: "in-process" };
  } catch {
    return { active: true, mode: "in-process" };
  }
}

/**
 * Check if AriKernel is active.
 */
export function isAriActive(): boolean {
  return firewall !== null;
}

/**
 * Shut down the kernel.
 */
export function stopAriKernel(): void {
  firewall = null;
}
