export interface ProtocolCondition {
  /** Variable or output key to evaluate */
  field: string;
  /** Comparison operator */
  operator: "equals" | "not_equals" | "contains" | "not_contains" | "exists" | "not_exists" | "gt" | "lt";
  /** Value to compare against (not needed for exists/not_exists) */
  value?: unknown;
}

export interface ProtocolStep {
  id: string;
  instruction: string;
  /** Tool calls the agent should make for this step */
  suggestedTools?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** If true, wait for user confirmation before proceeding */
  requiresUserAction?: boolean;
  /** Validation to run after step completes */
  validate?: string;
  /** Condition that must be true to execute this step (if branch) */
  condition?: ProtocolCondition;
  /** Step ID to jump to if condition is false (else branch) */
  elseStep?: string;
  /** Step ID to jump to after this step completes (instead of next sequential step) */
  nextStep?: string;
}

/** Where a protocol came from. Drives UI affordances (read-only built-ins,
 *  attribution links for imports) and dedupe logic when multiple sources
 *  define the same name. */
export interface ProtocolSource {
  /**
   * "builtin": ships in src/protocols/packs/*.ts (typed, code-defined)
   * "bundled": shipped via protocols/bundled/ (vendored SKILL.md from upstream)
   * "imported": user-imported SKILL.md in ~/.lax/protocols/imported/<name>/
   * "custom": user-authored typed protocol in ~/.lax/custom-protocols.json
   */
  type: "builtin" | "bundled" | "imported" | "custom";
  /** Upstream repo URL/slug for bundled or imported protocols */
  repo?: string;
  /** Source commit SHA at import time */
  commit?: string;
  /** Source license (must be MIT / Apache-2.0 / CC-BY-4.0 to be imported) */
  license?: string;
  /** Attribution string preserved per source license */
  attribution?: string;
  /** Path on disk to the source file (for hot-reload + edit-in-place) */
  sourcePath?: string;
}

export interface Protocol {
  name: string;
  description: string;
  /** When the agent should suggest this protocol */
  triggers: string[];
  steps: ProtocolStep[];
  /** Hard-won lessons encoded as rules */
  rules: string[];
  /** What user preferences this protocol can learn */
  learnablePreferences: string[];
  /** Markdown body for prompt-style protocols (imported SKILL.md). When
   *  present, protocol_get returns this as the executable instruction text;
   *  steps[] is empty. Built-in typed packs use steps[] and leave body unset. */
  body?: string;
  /** Tools the agent is allowed to call while executing this protocol.
   *  Enforced via session policy on protocol_get, mirroring the prior
   *  skill_run gating. Empty/undefined = no restriction. */
  allowedTools?: string[];
  /** Provenance + identity of where this protocol came from. Required for
   *  bundled/imported/custom; optional only for legacy in-memory builtins. */
  source?: ProtocolSource;
  /** UI grouping. Falls back to keyword-derived category if absent. */
  category?: string;
  /** Free-form tags for search + filter. */
  tags?: string[];
  /** Name of an existing protocol this one replaces. Set on creation to
   *  acknowledge "I know there's a similar one — delete it and use this
   *  instead". Bypasses the dedup similarity check for the named target. */
  supersedes?: string;
  /** Pinned protocols are exempt from automatic archive/purge transitions.
   *  Set this for rarely-used-but-critical workflows that shouldn't decay
   *  just because they don't fire often. */
  pinned?: boolean;
}
