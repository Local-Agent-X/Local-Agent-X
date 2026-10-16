// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Retrieval / search, secrets vault, memory (memory_* family), and self-edit.

import type { ToolPolicyRow } from "./tool-policies.types.js";

export const TOOL_POLICIES_MEMORY: Record<string, ToolPolicyRow> = {
  // ── Retrieval / search ──
  ari_retrieval:        { kernel: "internal",  risk: "safe", capabilities: ["sensitive-read"] },
  search_past_sessions: { kernel: "retrieval", risk: "safe", capabilities: [], rules: [{ id: "allow-search-past-sessions", decision: "allow", reason: "Search prior chat sessions", priority: 50 }] },
  memory_search:        { kernel: "retrieval", risk: "safe", capabilities: ["sensitive-read"] },
  // Raw conversation-history paging from the canonical op store (recall-tool.ts).
  // kernel "internal" (local read of ~/.lax op state, no ARI_ACTION_MAP needed).
  recall:               { kernel: "internal", risk: "safe", capabilities: [], rules: [{ id: "allow-recall", decision: "allow", reason: "Page raw messages of the agent's own op history (read-only)", priority: 50 }] },

  // ── Secrets vault ──
  clipboard_write_from_secret: { kernel: "secret-vault", risk: "secrets", capabilities: [] },
  request_secret:              { kernel: "internal", risk: "secrets", capabilities: [], rules: [{ id: "allow-request-secret", decision: "allow", reason: "Secret request (user confirms via UI)", priority: 50 }] },
  request_secrets:             { kernel: "internal", risk: "secrets", capabilities: [], rules: [{ id: "allow-request-secrets", decision: "allow", reason: "Multi-secret request (user confirms via UI)", priority: 50 }] },
  // Read-only: names / metadata only, never a secret VALUE. Risk "safe" (not
  // "secrets") so inspecting what's stored never trips an approval prompt — the
  // value-touching tools (request_secret, clipboard/browser *_secret) stay "secrets".
  list_secrets:                { kernel: "internal", risk: "safe", capabilities: [], rules: [{ id: "allow-list-secrets", decision: "allow", reason: "List secret names (no values exposed)", priority: 50 }] },
  get_secret_meta:             { kernel: "internal", risk: "safe", capabilities: [], rules: [{ id: "allow-get-secret-meta", decision: "allow", reason: "Secret metadata (no values exposed)", priority: 50 }] },

  // ── Memory ── (memory_* glob covers all; remember/update_fact/forget are no-prefix)
  memory_save:           { kernel: "database", risk: "workspace-write", capabilities: [] },
  memory_consolidate:    { kernel: "internal", risk: "workspace-write", capabilities: [] },
  memory_discover:       { kernel: "internal", risk: "safe", capabilities: [] },
  memory_dream:          { kernel: "internal", risk: "workspace-write", capabilities: [] },
  memory_forget:         { kernel: "internal", risk: "destructive", capabilities: [] },
  memory_forget_imports: { kernel: "internal", risk: "destructive", capabilities: [] },
  memory_get:            { kernel: "internal", risk: "safe", capabilities: [] },
  memory_ingest:         { kernel: "internal", risk: "workspace-write", capabilities: [], pathArgs: [{ arg: "directory", action: "read" }, { arg: "file", action: "read" }] },
  // A recall bumps the hot-score timestamp of the facts it returns
  // (memory-recall.ts reinforceFacts): bookkeeping the user never loses, so
  // the tier stays "safe" — the mutating tiers would make a recall count as
  // work for the loop guards (SPIRALABLE_TOOLS) and the failover checks.
  memory_recall:         { kernel: "internal", risk: "safe", capabilities: [] },
  memory_reflect:        { kernel: "internal", risk: "workspace-write", capabilities: [] },
  memory_reindex:        { kernel: "internal", risk: "workspace-write", capabilities: [] },
  memory_stats:          { kernel: "internal", risk: "safe", capabilities: [] },
  memory_set_user_field: { kernel: "internal", risk: "workspace-write", capabilities: [] },
  memory_update_profile: { kernel: "internal", risk: "workspace-write", capabilities: [] },
  remember:    { kernel: "internal", risk: "workspace-write", capabilities: [], rules: [{ id: "allow-remember", decision: "allow", reason: "Save durable fact to Facts DB (internal)", priority: 50 }] },
  update_fact: { kernel: "internal", risk: "workspace-write", capabilities: [], rules: [{ id: "allow-update-fact", decision: "allow", reason: "Correct a fact in the Facts DB (internal)", priority: 50 }] },
  forget:      { kernel: "internal", risk: "destructive", capabilities: [], rules: [{ id: "allow-forget", decision: "allow", reason: "Soft-delete a fact in the Facts DB (internal)", priority: 50 }] },

  // ── Self-edit — sandboxed, but the merge mutates running source ──
  self_edit: { kernel: "internal", risk: "destructive", capabilities: [], rules: [{ id: "allow-self-edit", decision: "allow", reason: "Agent self-repair via Claude Code subprocess", priority: 50 }] },
};
