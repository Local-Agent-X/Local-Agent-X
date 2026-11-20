// Per-tool "did the agent do something" classification for the loop-liveness
// guards (agent-guards/loop-detection.ts no-progress + discovery detectors, and
// turn-loop/tool-failure-summary.ts hadSuccessfulMutation). Sibling projection
// to committing-tool-check.ts: both derive a boolean from the ONE risk taxonomy
// (tool-registry.ts), so adding a tool to the policy table is the only edit any
// consumer needs. The hand-maintained Sets this replaced drifted exactly the
// way committing-tool-check's pre-derivation list did — a side-effecting tool
// left off the list read as "no progress" and got turns false-aborted mid-work
// (the 2026-05-13 vendor-PO browser run).
//
// Two distinct notions, each its own risk-class selection — NOT one minus the
// other. They overlap on workspace-write + destructive and diverge elsewhere:
//
//   mutation — the agent effected something OBSERVABLE this turn (file write,
//     external API/comms, secret, scheduling). Resets the no-progress counter.
//     EXCLUDES ordinary `shell`: bash can spin without doing anything (git-status / grep
//     loops), and catching that spin is the no-progress guard's whole job — the
//     build_app 96-bash-call kill. Active external plugin tools are the exception:
//     their contract is always non-idempotent, so successful calls are mutations.
//     EXCLUDES `network-read` as a tier (web_fetch
//     is a read, not an action), but `browser` is overridden in because its
//     clicks/navigations are real external side effects (the PO-entry fix).
//
//   progress — the agent did LOCAL work proving prior reads were scaffolding
//     (write / edit / bash / build / plan / delegate). Resets the discovery-loop
//     counter. INCLUDES `shell` (running commands is work) but NOT network/comms
//     — a turn still fetching/sending is gathering, not acting on findings.

import { TOOLS, isMcpServerWrite, type ToolRisk } from "./tool-registry.js";
import { getActivePluginToolMetadata } from "./plugin-system/tool-metadata.js";

// Observable external side effects (no-progress reset). `network-read` is absent
// on purpose — a bare fetch is a read, not an action; `browser` is added back via
// MUTATION_OVERRIDES because its actions mutate external systems.
const MUTATION_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  "workspace-write",
  "network-write",
  "destructive",
  "money",
  "external-comms",
  "secrets",
  "publish",
]);

// Local "I did work" tiers (discovery-loop reset). Includes `shell` (bash is
// work for the discovery counter, even though it can't count toward no-progress)
// and excludes network/comms (still gathering, not acting).
const PROGRESS_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  "workspace-write",
  "shell",
  "destructive",
]);

// Mutations the risk taxonomy doesn't capture. `browser` is network-read by tier
// but its actions are real side effects. (Plugin tools count through their
// active metadata, and a connected MCP server's writes through its listing,
// below.)
const MUTATION_OVERRIDES: ReadonlySet<string> = new Set<string>(["browser"]);

/** True if the tool effected something observable this turn — resets the
 *  no-progress counter. Excludes ordinary shell; active plugin contracts are
 *  explicitly non-idempotent and count conservatively as mutations. */
export function isMutationTool(name: string): boolean {
  if (getActivePluginToolMetadata(name)) return true;
  if (MUTATION_OVERRIDES.has(name) || isMcpServerWrite(name)) return true;
  const r = TOOLS[name]?.risk;
  return r !== undefined && MUTATION_RISKS.has(r);
}

/** True if the tool proves the agent did local work, not spinning — resets the
 *  discovery-loop counter. Includes shell, excludes network/comms. */
export function isProgressTool(name: string): boolean {
  if (getActivePluginToolMetadata(name)) return true;
  const r = TOOLS[name]?.risk;
  return r !== undefined && PROGRESS_RISKS.has(r);
}
