// HOST_CAPABILITY_MANIFEST — the (toolClass, action) pairs this LAX process
// is entitled to ask the AriKernel about — plus the session→preset mapping.
//
// Capability ≠ permission. A manifest entry says: "the host is allowed to
// ASK the kernel to evaluate this action class." The per-call rule engine
// (taint analysis, policy matching, approval requirements, audit logging)
// still decides allow/deny for every individual call. Capabilities issue
// once at startup; rules run on every request.
//
// INVARIANT: adding a new tool class to TOOL_CLASS_MAP requires adding a
// matching manifest entry — otherwise the new tool will fail-closed with
// "Capability token required" (protected actions) or "No capability grant
// for tool class" (policy-engine capability check).

import type { Capability, ToolClass } from "@arikernel/core";

export const HOST_CAPABILITY_MANIFEST: ReadonlyArray<{ toolClass: ToolClass; action: string }> = [
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
  // clipboard_write_from_secret (per secretVaultActionMap in evaluate)
  { toolClass: "secret-vault", action: "capture" },
  { toolClass: "secret-vault", action: "fill" },
  { toolClass: "secret-vault", action: "clipboard" },
];

// Aggregate actions per toolClass so each toolClass appears once with the
// full set of permitted actions.
export function buildPrincipalCapabilities(): Capability[] {
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

const SESSION_TO_ARI_PRESET: Record<string, string> = {
  "default": "workspace-assistant",
  "high-security": "strict",
  "dev-mode": "research",
  "read-only": "safe",
};

export function getAriPresetForSession(sessionPreset: string): string {
  return SESSION_TO_ARI_PRESET[sessionPreset] || "workspace-assistant";
}
