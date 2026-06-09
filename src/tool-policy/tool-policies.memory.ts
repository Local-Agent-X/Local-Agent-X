// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Retrieval / search, secrets vault, memory (memory_* family), and self-edit.

import type { ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_MEMORY: Record<string, ToolPolicyEntry> = {
  // ── Retrieval / search ──
  ari_retrieval:        { kernel: "internal",  risk: "safe" },
  search_past_sessions: { kernel: "retrieval", risk: "safe", rules: [{ id: "allow-search-past-sessions", decision: "allow", reason: "Search prior chat sessions", priority: 50 }] },
  memory_search:        { kernel: "retrieval", risk: "safe" },

  // ── Secrets vault ──
  clipboard_write_from_secret: { kernel: "secret-vault", risk: "secrets" },
  request_secret:              { kernel: "internal", risk: "secrets", rules: [{ id: "allow-request-secret", decision: "allow", reason: "Secret request (user confirms via UI)", priority: 50 }] },
  request_secrets:             { kernel: "internal", risk: "secrets", rules: [{ id: "allow-request-secrets", decision: "allow", reason: "Multi-secret request (user confirms via UI)", priority: 50 }] },
  list_secrets:                { kernel: "internal", risk: "secrets", rules: [{ id: "allow-list-secrets", decision: "allow", reason: "List secret names (no values exposed)", priority: 50 }] },
  get_secret_meta:             { kernel: "internal", risk: "secrets", rules: [{ id: "allow-get-secret-meta", decision: "allow", reason: "Secret metadata (no values exposed)", priority: 50 }] },

  // ── Memory ── (memory_* glob covers all; remember/update_fact/forget are no-prefix)
  memory_save:           { kernel: "database", risk: "workspace-write" },
  memory_consolidate:    { kernel: "internal", risk: "workspace-write" },
  memory_discover:       { kernel: "internal", risk: "safe" },
  memory_dream:          { kernel: "internal", risk: "workspace-write" },
  memory_forget:         { kernel: "internal", risk: "destructive" },
  memory_forget_imports: { kernel: "internal", risk: "destructive" },
  memory_get:            { kernel: "internal", risk: "safe" },
  memory_ingest:         { kernel: "internal", risk: "workspace-write" },
  memory_recall:         { kernel: "internal", risk: "safe" },
  memory_reflect:        { kernel: "internal", risk: "workspace-write" },
  memory_reindex:        { kernel: "internal", risk: "workspace-write" },
  memory_stats:          { kernel: "internal", risk: "safe" },
  memory_set_user_field: { kernel: "internal", risk: "workspace-write" },
  memory_update_profile: { kernel: "internal", risk: "workspace-write" },
  remember:    { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-remember", decision: "allow", reason: "Save durable fact to Facts DB (internal)", priority: 50 }] },
  update_fact: { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-update-fact", decision: "allow", reason: "Correct a fact in the Facts DB (internal)", priority: 50 }] },
  forget:      { kernel: "internal", risk: "destructive", rules: [{ id: "allow-forget", decision: "allow", reason: "Soft-delete a fact in the Facts DB (internal)", priority: 50 }] },

  // ── Self-edit — sandboxed, but the merge mutates running source ──
  self_edit: { kernel: "internal", risk: "destructive", rules: [{ id: "allow-self-edit", decision: "allow", reason: "Agent self-repair via Claude Code subprocess", priority: 50 }] },
};
