// Tool taxonomy types + the derived TOOLS projection.
//
// The DATA lives in the unified policy table (src/tool-policy/tool-policies.data.ts),
// which joins each tool's kernel class, risk tier, explicit policy rule(s), and
// rate-limit cap in ONE entry. This module owns the taxonomy TYPES and projects
// the table's concrete-tool entries into TOOLS for the kernel/autonomy consumers:
//
//   kernel:  what defense pipeline runs at dispatch? (ari-kernel/evaluate.ts)
//   risk:    what does the user lose if this fires without approval?
//            (consumed by autonomy gate + approval-manager)
//
// TOOL_CLASS_MAP (ari-kernel/tool-class-map.ts) and TOOL_RISK (autonomy/risk.ts)
// remain the derived projections downstream consumers import. Adding a tool is a
// single edit to the table; a kernel tool missing a policy rule is caught by
// auditPolicyCoverage at boot (and the orphan test), not papered over by a
// silent risk-tier fallback.

import { deriveTools, derivePathArgs } from "./tool-policy/tool-policies.js";
import type { PathArgSpec } from "./tool-policy/tool-policies.data.js";
export type { PathArgSpec } from "./tool-policy/tool-policies.data.js";

export type KernelClass =
  | "file"
  | "http"
  | "shell"
  | "database"
  | "retrieval"
  | "secret-vault"
  | "internal";

export type ToolRisk =
  | "safe"             // read-only local / pure compute / catalog lookup
  | "workspace-write"  // creates or mutates files in workspace/ or LAX state
  | "network-read"     // outbound read-only (GET fetch, search, scrape)
  | "network-write"    // outbound state-changing (POST/PUT/DELETE)
  | "shell"            // subprocess spawn / arbitrary command execution
  | "destructive"      // irreversible delete / overwrite / cancel / uninstall
  | "money"            // bills a real-world account (payments, paid APIs)
  | "external-comms"   // sends a message a third party will see
  | "secrets";         // touches the credential vault — read, write, or fill-from

export interface ToolEntry {
  kernel: KernelClass;
  risk: ToolRisk;
}

// Kernel classes that gate at dispatch (taint analysis, capability check,
// audit log). "internal" runs entirely inside LAX state — dispatch skips
// the kernel. See ari-kernel/tool-class-map.ts:shouldGateInKernel.
export const GATED_KERNEL_CLASSES: ReadonlySet<KernelClass> = new Set<KernelClass>([
  "file", "http", "shell", "database", "retrieval", "secret-vault",
]);

/** Concrete-tool taxonomy, projected from the unified policy table. */
export const TOOLS: Record<string, ToolEntry> = deriveTools();

// Tool → caller-supplied file path arg(s). SecurityLayer routes each through
// evaluateFileAccess so the file-access mode confines EVERY file sink — not just
// the four raw fs tools. A path-opening tool absent here bypasses confinement.
export const TOOL_PATH_ARGS: Record<string, PathArgSpec[]> = derivePathArgs();

// ── Capability classes (THE single source of truth for I/O-sink gating) ──
//
// Security gates must NOT key on literal canonical tool NAMES: the ari_* bridge
// tools and other synonyms (email_send, browser, clipboard_write, process_start,
// ari_file, email_read, memory_search) are the SAME I/O sinks under names no
// gate recognizes — so name-keyed gates let them bypass egress / sensitive-read
// / worktree enforcement. Classify each sink by CAPABILITY CLASS and key the
// gates on class membership so synonyms are enforced identically to canonicals.
//
// A tool may belong to multiple classes (e.g. bash is sensitive-read AND shell).
// Canonical-tool membership below EXACTLY matches the gates' former hardcoded
// lists — the synonyms are what's newly added.
export type CapabilityClass = "egress" | "sensitive-read" | "workspace-write" | "shell";

// Egress = can send data off-box or to another app/process (data-exfil sinks).
const EGRESS_TOOLS: ReadonlySet<string> = new Set([
  "http_request", "web_fetch", // canonical (was the data-lineage gate's hardcoded list)
  "ari_http",                  // kernel HTTP bridge — same off-box sink
  "email_send",                // sends a message a third party receives
  "clipboard_write",           // crosses into another app's read surface
  "process_start",             // spawns a subprocess that can carry data off-box
  "browser",                   // browser navigation/fetch actions (browser_* below)
  "extract_site_assets",       // model-controlled url → off-box GET (was DNS-pin only)
  "youtube_analyze",           // model-derived url → off-box GET + yt-dlp spawn
]);

// Sensitive-read = can surface file/secret/PII content into the model context.
const SENSITIVE_READ_TOOLS: ReadonlySet<string> = new Set([
  "read", "bash", "sql_query",                       // canonical (was run-sandboxed's list)
  "ari_file",                                         // kernel file read bridge
  "email_read", "memory_search", "grep", "glob",      // surface mailbox / memory / file content
  "ari_retrieval", "ari_database", "ari_sqlite",      // kernel retrieval / db read bridges
]);

// Workspace-write = mutates files; subject to worktree containment.
const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write", "edit",  // canonical
  "ari_file",        // kernel file write bridge (action: 'write')
]);

// Shell = subprocess spawn / arbitrary command execution.
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash",          // canonical
  "shell", "ari_shell", "process_start",
]);

const CAPABILITY_SETS: Record<CapabilityClass, ReadonlySet<string>> = {
  "egress": EGRESS_TOOLS,
  "sensitive-read": SENSITIVE_READ_TOOLS,
  "workspace-write": WORKSPACE_WRITE_TOOLS,
  "shell": SHELL_TOOLS,
};

// Read-only view of the capability-class membership, exposed for the build-time
// name-drift assertion (capability-class-gates.test.ts). Every member here must
// resolve to a real registered tool (or an explicitly-whitelisted bare synonym)
// — name drift like `ari_sqlite_database` or a forgotten egress registration
// becomes a TEST FAILURE instead of a silent fail-closed/fail-open hole.
export const CAPABILITY_CLASS_MEMBERS: Record<CapabilityClass, readonly string[]> = {
  "egress": [...EGRESS_TOOLS],
  "sensitive-read": [...SENSITIVE_READ_TOOLS],
  "workspace-write": [...WORKSPACE_WRITE_TOOLS],
  "shell": [...SHELL_TOOLS],
};

/**
 * Does `name` belong to capability class `cls`?
 *
 * The `browser_*` family (browser navigation/fetch sub-actions) is folded into
 * the egress class by prefix so synonyms like `browser_navigate` are gated like
 * `browser`. All other membership is exact-name.
 */
export function hasCapability(name: string, cls: CapabilityClass): boolean {
  if (CAPABILITY_SETS[cls].has(name)) return true;
  if (cls === "egress" && name.startsWith("browser_")) {
    // Vault-only browser sub-tools write INTO the page from the encrypted vault;
    // the value never enters model context, so they aren't data-exfil egress.
    if (name === "browser_capture_to_secret" || name === "browser_fill_from_secret") return false;
    return true;
  }
  return false;
}

/** Tool names that take a `path` arg and must be subject to worktree containment. */
export const WORKTREE_PATH_TOOLS: ReadonlySet<string> = new Set([
  ...WORKSPACE_WRITE_TOOLS, "read", "glob", "grep",
]);
