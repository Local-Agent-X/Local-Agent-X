// Tool → kernel-class mapping. Derived projection from the single source
// of truth in src/tool-registry.ts. Two semantic kinds:
//
//   - GATED CLASS (file / http / shell / database / retrieval / secret-vault)
//     Kernel evaluates the call at the dispatch layer (Layer -1 in the
//     enforce-policy phase) — taint analysis, capability check, audit log.
//   - "internal"
//     Tool runs entirely inside LAX state (no raw I/O, or raw I/O that
//     already routes through a kernel-direct path like arikernel-bridge).
//     Dispatch skips the kernel for these.
//
// Unmapped tools fail-closed — shouldGateInKernel returns true so the
// kernel sees them with no class match and blocks. Adding a tool to
// TOOLS in tool-registry.ts is enforced at the type level (both kernel
// and risk fields required), so the old "twin-map drift" failure mode
// is now a compile error.
//
// Autonomy risk classification (TOOL_RISK / classifyToolRisk / ToolRisk)
// is the sibling projection — see src/autonomy/risk.ts.

import { createLogger } from "../logger.js";
import { TOOLS, GATED_KERNEL_CLASSES, type KernelClass } from "../tool-registry.js";
import { getActivePluginToolMetadata } from "../plugin-system/tool-metadata.js";

const logger = createLogger("ari-kernel");

export const TOOL_CLASS_MAP: Record<string, KernelClass> = Object.fromEntries(
  Object.entries(TOOLS).map(([name, entry]) => [name, entry.kernel]),
);

export const GATED_CLASSES: ReadonlySet<string> = GATED_KERNEL_CLASSES;

// External MCP-server tools register dynamically (names like
// mcp_github_create_issue), so they can NEVER appear in the static TOOLS
// table. Recognize them by the canonical `mcp_` prefix that getAllTools()
// stamps on every server tool (src/mcp-client/index.ts).
const MCP_TOOL_PREFIX = "mcp_";
export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

// Resolve a tool's kernel class, including dynamic MCP tools. An MCP server is
// external untrusted I/O reached over a subprocess, so its tools are classified
// "http": the kernel then taint-checks + audits the call (a prompt-injected arg
// reaching a real GitHub/Slack/DB API is exactly the http exfiltration threat)
// and ALLOWS it when clean — instead of fail-closed blocking every MCP call
// because its name isn't in the static map.
export function kernelClassForTool(toolName: string): KernelClass | undefined {
  const cls = TOOL_CLASS_MAP[toolName];
  if (cls !== undefined) return cls;
  if (isMcpToolName(toolName)) return "http";
  const plugin = getActivePluginToolMetadata(toolName);
  if (plugin) return plugin.kernel;
  return undefined;
}

const _seenUnmappedTools = new Set<string>();

// Returns true for:
//   - tools mapped to a gated I/O class (file/http/shell/database/retrieval/secret-vault)
//   - tools NOT in the map (fail-closed: missing classification = treat as risky)
// Returns false ONLY for tools explicitly classified "internal".
//
// Why fail-closed on unmapped: a new tool added without a registry entry
// is, by definition, an unaudited I/O surface. Defaulting to "skip the
// kernel" means a prompt-injection-controlled parameter could reach an
// I/O sink with the deepest defense layer disabled. Forcing-function for
// coverage.
export function shouldGateInKernel(toolName: string): boolean {
  const cls = kernelClassForTool(toolName);
  if (cls === undefined) {
    if (!_seenUnmappedTools.has(toolName)) {
      _seenUnmappedTools.add(toolName);
      logger.warn(`[ari] ${toolName} not in TOOLS — defaulting to BLOCK (fail-closed). Add to TOOLS in src/tool-registry.ts to classify.`);
    }
    return true;
  }
  return GATED_KERNEL_CLASSES.has(cls);
}

// Should this tool flow through the kernel's audit-only observation path?
// Returns true ONLY for "internal" class — orchestration, LAX state
// transitions, structured workspace docs. These don't have an agent-
// controlled I/O sink the kernel can defend, so they SKIP the enforcement
// pipeline. But they still pass through ariObserve so the operator gets a
// uniform "[ari] every tool call" audit trail.
export function shouldObserveInKernel(toolName: string): boolean {
  return TOOL_CLASS_MAP[toolName] === "internal";
}
