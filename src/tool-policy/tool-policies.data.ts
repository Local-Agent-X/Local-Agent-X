// THE unified per-tool policy table. One entry per tool (or glob family),
// joining all four formerly-scattered policy sources:
//
//   kernel    — defense pipeline at dispatch (ari-kernel/evaluate.ts)
//   risk      — what the user loses if it fires unapproved (autonomy gate)
//   rules     — explicit allow/deny/confirm rules (priority, argMatch, action,
//               constraints) — the old DEFAULT_POLICY.rules, re-homed per tool
//   rateLimit — sliding-window cap — the old DEFAULT_LIMITS
//
// Adding a tool is now ONE edit here. The derivations (tool-policies.ts)
// project this table into TOOLS / DEFAULT_POLICY / DEFAULT_LIMITS for the
// downstream consumers, and auditPolicyCoverage cross-checks that every
// kernel tool is reachable by a rule (no silent risk-tier fallback anymore).
//
// Keys are tool names OR glob patterns ("memory_*"): a concrete tool entry
// carries kernel+risk; a glob entry carries only the shared rule that covers
// a family. A tool's decision may therefore come from its own entry or from
// its family glob — both live in this one table.
//
// SECURITY INVARIANT (AGENTS.md): new tools need an EXPLICIT allow-<name>
// rule; default-deny. Do not add a broad "*"-style allow that would silently
// admit future tools.
//
// The entries are split across per-domain fragment files (tool-policies.<domain>.ts)
// purely to keep each file under the 400-LOC cap; they are merged below into the
// single exported TOOL_POLICIES record. The fragments partition the keyspace —
// no key appears in more than one fragment, so the spread order is irrelevant
// (no entry can silently override another). The type contract lives in
// tool-policies.types.ts and is re-exported here so importer paths are unchanged.

import type { ToolPolicyEntry } from "./tool-policies.types.js";
import { TOOL_POLICIES_CORE } from "./tool-policies.core.js";
import { TOOL_POLICIES_NETWORK } from "./tool-policies.network.js";
import { TOOL_POLICIES_MEMORY } from "./tool-policies.memory.js";
import { TOOL_POLICIES_ORCHESTRATION } from "./tool-policies.orchestration.js";
import { TOOL_POLICIES_APPS } from "./tool-policies.apps.js";
import { TOOL_POLICIES_GLOBS } from "./tool-policies.globs.js";

export type { ToolRateLimit, PathArgSpec, ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES: Record<string, ToolPolicyEntry> = {
  ...TOOL_POLICIES_CORE,
  ...TOOL_POLICIES_NETWORK,
  ...TOOL_POLICIES_MEMORY,
  ...TOOL_POLICIES_ORCHESTRATION,
  ...TOOL_POLICIES_APPS,
  ...TOOL_POLICIES_GLOBS,
};
