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

import {
  CAPABILITY_CLASS_MAP,
  deriveCapabilityClass,
  generateId,
  getPreset,
  now,
} from "@arikernel/core";
import type {
  Capability,
  CapabilityClass,
  CapabilityGrant,
  PresetId,
  ToolClass,
} from "@arikernel/core";
import { TokenStore, createFirewall } from "@arikernel/runtime";
import type { Firewall, FirewallHooks } from "@arikernel/runtime";

import { createLogger } from "./logger.js";
import { USER_HINTS } from "./types.js";
const logger = createLogger("ari-kernel");

let firewall: Firewall | null = null;
let hostTokenStore: TokenStore | null = null;
let hostGrantsByCapClass: Map<CapabilityClass, string> = new Map();
let currentPreset: string = "workspace-assistant";
// Default true so the deepest gate is load-bearing even if a caller forgets
// to pass `required`. The config layer (src/config.ts: ariRequired) is the
// canonical source — this is just the safety net.
let ariIsRequired: boolean = true;

const HOST_PRINCIPAL_NAME = "lax-host";

/**
 * HOST_CAPABILITY_MANIFEST — the set of protected (toolClass, action) pairs
 * this LAX process is entitled to ask the AriKernel about.
 *
 * Capability ≠ permission. A manifest entry says: "the host is allowed to
 * ASK the kernel to evaluate this action class." The per-call rule engine
 * (taint analysis, policy matching, approval requirements, audit logging)
 * still decides allow/deny for every individual call. Capabilities issue
 * once at startup; rules run on every request.
 *
 * Every entry below corresponds to a (toolClass, action) pair the LAX
 * dispatcher (toolClassMap below + tool-executor.ts actionMap) can route
 * to firewall.execute(). The dispatcher's `internal` class never reaches
 * the kernel, so it's not listed here.
 *
 * INVARIANT: adding a new tool class to toolClassMap requires adding a
 * matching manifest entry — otherwise the new tool will fail-closed with
 * "Capability token required" (protected actions) or "No capability grant
 * for tool class" (policy-engine capability check).
 */
const HOST_CAPABILITY_MANIFEST: ReadonlyArray<{ toolClass: ToolClass; action: string }> = [
  // http — web_search, web_fetch, http_request, browser
  { toolClass: "http", action: "get" },
  { toolClass: "http", action: "head" },
  { toolClass: "http", action: "options" },
  { toolClass: "http", action: "post" },
  { toolClass: "http", action: "put" },
  { toolClass: "http", action: "patch" },
  { toolClass: "http", action: "delete" },
  // file — read / write (edit normalizes to write in tool-executor actionMap)
  { toolClass: "file", action: "read" },
  { toolClass: "file", action: "write" },
  // shell — bash
  { toolClass: "shell", action: "exec" },
  // database — memory_save and any future database-backed tool
  { toolClass: "database", action: "query" },
  { toolClass: "database", action: "exec" },
  { toolClass: "database", action: "mutate" },
  // retrieval — memory_search (unprotected by CAPABILITY_CLASS_MAP, but the
  // policy engine still requires the principal to declare this toolClass)
  { toolClass: "retrieval", action: "search" },
  // secret-vault — browser_capture_to_secret, browser_fill_from_secret,
  // clipboard_write_from_secret (per secretVaultActionMap in ariEvaluate)
  { toolClass: "secret-vault", action: "capture" },
  { toolClass: "secret-vault", action: "fill" },
  { toolClass: "secret-vault", action: "clipboard" },
];

// Long-lived host grants — issued once at startup, used for the whole
// process lifetime. They occupy the same lease shape any other grant
// uses, but with an effectively unbounded maxCalls and a far-future
// expiry because the host's entitlement does not change at runtime.
const HOST_GRANT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

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
 * Build the principal.capabilities array from HOST_CAPABILITY_MANIFEST —
 * aggregate actions per toolClass so each toolClass appears once with
 * the full set of permitted actions.
 */
function buildPrincipalCapabilities(): Capability[] {
  const byClass = new Map<ToolClass, Set<string>>();
  for (const { toolClass, action } of HOST_CAPABILITY_MANIFEST) {
    let actions = byClass.get(toolClass);
    if (!actions) {
      actions = new Set();
      byClass.set(toolClass, actions);
    }
    actions.add(action);
  }
  return [...byClass.entries()].map(([toolClass, actions]) => ({
    toolClass,
    actions: [...actions],
  }));
}

/**
 * Mint long-lived host grants for every unique capability class derived
 * from the manifest, store them in the kernel's token store, and return
 * the (capabilityClass → grantId) map used by ariEvaluate to attach the
 * right grantId on each execute() call.
 *
 * Grants are minted directly rather than via firewall.requestCapability()
 * because the issuer's default lease (5 minutes / 10 calls) would force
 * either per-request re-issuance or silent re-mints — both forbidden by
 * the manifest model. The host principal is its own grant authority
 * for the actions it has declared up-front.
 */
function mintHostGrants(
  store: TokenStore,
  principalId: string,
): Map<CapabilityClass, string> {
  const capClasses = new Set<CapabilityClass>();
  for (const { toolClass, action } of HOST_CAPABILITY_MANIFEST) {
    const capClass = deriveCapabilityClass(toolClass, action);
    const mapping = CAPABILITY_CLASS_MAP[capClass];
    // Only protected (toolClass, action) pairs need a grant. Unprotected
    // pairs (e.g. retrieval.search) pass the pipeline's capability gate
    // without a grant and only need the principal declaration.
    if (
      mapping &&
      mapping.toolClass === toolClass &&
      mapping.actions.includes(action.toLowerCase())
    ) {
      capClasses.add(capClass);
    }
  }
  const issuedAt = now();
  const expiresAt = new Date(Date.now() + HOST_GRANT_TTL_MS).toISOString();
  const map = new Map<CapabilityClass, string>();
  for (const capClass of capClasses) {
    const grant: CapabilityGrant = {
      id: generateId(),
      requestId: generateId(),
      principalId,
      capabilityClass: capClass,
      constraints: {},
      lease: {
        issuedAt,
        expiresAt,
        maxCalls: Number.MAX_SAFE_INTEGER,
        callsUsed: 0,
      },
      taintContext: [],
      revoked: false,
    };
    store.store(grant);
    map.set(capClass, grant.id);
  }
  return map;
}

/**
 * Look up the grantId to attach to a tool call. Returns undefined when
 * the (toolClass, action) pair is not protected by CAPABILITY_CLASS_MAP —
 * in that case the pipeline's capability gate is a no-op and passing a
 * grantId would actually fail validateToken (since the action wouldn't
 * be in the grant's capability class action list).
 */
function lookupHostGrantId(toolClass: string, action: string): string | undefined {
  const capClass = deriveCapabilityClass(toolClass, action);
  const mapping = CAPABILITY_CLASS_MAP[capClass];
  if (!mapping || mapping.toolClass !== toolClass) return undefined;
  if (!mapping.actions.includes(action.toLowerCase())) return undefined;
  return hostGrantsByCapClass.get(capClass);
}

/**
 * Initialize AriKernel in-process.
 * Returns true if started successfully, false if unavailable.
 */
export async function startAriKernel(auditDbPath: string, preset?: string, required?: boolean): Promise<boolean> {
  currentPreset = preset || "workspace-assistant";
  ariIsRequired = required ?? true;

  try {
    const presetConfig = getPreset(currentPreset as PresetId);
    hostTokenStore = new TokenStore();
    // Approval is owned by LAX's user-facing layer (riskLevel → UI prompt
    // in tool-executor.ts). The kernel's approval hook would otherwise
    // double-prompt or — without a hook — deny outright. Delegate by
    // returning true; deny / taint / capability layers all still fire
    // before the approval hook is ever called.
    const hooks: FirewallHooks = {
      onApprovalRequired: async () => true,
    };
    firewall = createFirewall({
      principal: {
        name: HOST_PRINCIPAL_NAME,
        capabilities: buildPrincipalCapabilities(),
      },
      policies: presetConfig.policies,
      auditLog: auditDbPath,
      mode: "embedded",
      tokenStore: hostTokenStore,
      hooks,
    });

    // Manifest-driven grant issuance — runs exactly once, right after
    // the firewall is constructed. The per-call rule engine (taint /
    // policy / approval / audit) still evaluates every tool call on top
    // of these grants.
    hostGrantsByCapClass = mintHostGrants(hostTokenStore, firewall.principalInfo.id);
    logger.info(`  [ari] Granted ${hostGrantsByCapClass.size} host capabilities (manifest entries: ${HOST_CAPABILITY_MANIFEST.length})`);

    // Register no-op executors for every toolClass in the manifest. ARI's
    // role is observer + gate; the real tool logic (http fetch, file I/O,
    // shell exec, vault read/write, …) runs in LAX's own dispatcher AFTER
    // ariEvaluate returns allowed. Without these stubs, the kernel would
    // try to perform the action itself via its built-in executors and
    // either fail (path-traversal-blocked on /etc/hostname) or duplicate
    // the side-effect of the real tool call.
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
    const grantId = lookupHostGrantId(toolClass, effectiveAction);
    if (grantId) execRequest.grantId = grantId;
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
  try {
    firewall?.close?.();
  } catch {
    /* ignore */
  }
  firewall = null;
  hostTokenStore = null;
  hostGrantsByCapClass = new Map();
}
