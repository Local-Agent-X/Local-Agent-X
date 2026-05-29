import type { ToolPolicyConfig } from "./types.js";
import { deriveDefaultRules } from "./tool-policies.js";

// DEFAULT-DENY: everything is blocked unless explicitly allowed by a rule.
// Rules are no longer hand-maintained here — they are derived from the unified
// per-tool table (tool-policies.data.ts), so adding/auditing a tool's policy is
// one edit colocated with its kernel class, risk tier, and rate limit.
// Users can still override via ~/.lax/tool-policy.json.
export const DEFAULT_POLICY: ToolPolicyConfig = {
  defaultDecision: "deny",
  rules: deriveDefaultRules(),
};
