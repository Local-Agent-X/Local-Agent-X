// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Retrieval / search, secrets vault, memory (memory_* family), and self-edit.

import type { ToolPolicyRow } from "./tool-policies.types.js";

export const TOOL_POLICIES_MEMORY: Record<string, ToolPolicyRow> = {
  // ── Retrieval / search ──
  ari_retrieval:        { kernel: "internal",  risk: "safe", capabilities: ["sensitive-read"], tags: [], reads: ["session"] },
  // Lookups are local (FTS + the local embedder) and normally sub-second; a
  // measured 71 s stall was a hang that blocked the turn. 30 s, not 15 s: the
  // first search after a cold boot pays the ~16.5 s embedder load. Read-only,
  // so killing a real stall strands nothing.
  search_past_sessions: { kernel: "retrieval", ariAction: "search", risk: "safe", capabilities: [], tags: [], timeoutMs: 30_000, reads: ["session"], rules: [{ id: "allow-search-past-sessions", decision: "allow", reason: "Search prior chat sessions", priority: 50 }] },
  memory_search:        { kernel: "retrieval", ariAction: "search", risk: "safe", capabilities: ["sensitive-read"], tags: ["memory-search"], essentialRank: 9, blurb: { say: "what do you know about my projects?", does: "Search long-term memory." }, timeoutMs: 30_000, reads: ["session"], loop: { discovery: true } },
  // Raw conversation-history paging from the canonical op store (recall-tool.ts).
  // kernel "internal" (local read of ~/.lax op state, no ARI_ACTION_MAP needed).
  // It resolves session → op from the trusted session.
  recall:               { kernel: "internal", risk: "safe", capabilities: [], tags: [], reads: ["session"], rules: [{ id: "allow-recall", decision: "allow", reason: "Page raw messages of the agent's own op history (read-only)", priority: 50 }] },

  // ── Secrets vault ──
  clipboard_write_from_secret: { kernel: "secret-vault", ariAction: "clipboard", risk: "secrets", capabilities: [], tags: [], essentialRank: 29 },
  // Waits on a modal the user answers, bounded by that surface's own timeout:
  // a harness timeout killed the wait first and the retry raised a second card.
  request_secret:              { kernel: "internal", risk: "secrets", capabilities: [], tags: ["secret-store"], essentialRank: 30, blurb: { say: "I need to store my OpenAI key", does: "Securely request + store a secret." }, timeoutMs: 0, liveState: "fresh", rules: [{ id: "allow-request-secret", decision: "allow", reason: "Secret request (user confirms via UI)", priority: 50 }] },
  request_secrets:             { kernel: "internal", risk: "secrets", capabilities: [], tags: ["secret-store"], blurb: { does: "Request multiple secrets." }, timeoutMs: 0, liveState: "fresh", rules: [{ id: "allow-request-secrets", decision: "allow", reason: "Multi-secret request (user confirms via UI)", priority: 50 }] },
  // Read-only: names / metadata only, never a secret VALUE. Risk "safe" (not
  // "secrets") so inspecting what's stored never trips an approval prompt — the
  // value-touching tools (request_secret, clipboard/browser *_secret) stay "secrets".
  list_secrets:                { kernel: "internal", risk: "safe", capabilities: [], tags: ["secret-store"], essentialRank: 28, blurb: { does: "List stored secret names (never values)." }, rules: [{ id: "allow-list-secrets", decision: "allow", reason: "List secret names (no values exposed)", priority: 50 }] },
  get_secret_meta:             { kernel: "internal", risk: "safe", capabilities: [], tags: [], rules: [{ id: "allow-get-secret-meta", decision: "allow", reason: "Secret metadata (no values exposed)", priority: 50 }] },

  // ── Memory ── (memory_* glob covers all; remember/update_fact/forget are no-prefix)
  // A row insert into the daily-log SQLite table: the database class's actions
  // are query/exec/mutate, and "write" tripped deny-by-default in the kernel.
  // The memory writes below that return nothing to read back are `memoryWrite`;
  // remember/update_fact also record the user message they answered
  // (facts.source_message_id), so a fact points at the words it came from.
  memory_save:           { kernel: "database", ariAction: "mutate", risk: "workspace-write", capabilities: [], tags: [], essentialRank: 8, blurb: { say: "remember that I prefer tabs over spaces", does: "Save a fact to memory." }, reads: ["session"], memoryWrite: true },
  memory_consolidate:    { kernel: "internal", risk: "workspace-write", capabilities: [], tags: [], blurb: { say: "consolidate recent conversations", does: "Extract durable facts from recent chunks." } },
  memory_discover:       { kernel: "internal", risk: "safe", capabilities: [], tags: [] },
  memory_dream:          { kernel: "internal", risk: "workspace-write", capabilities: [], tags: [], blurb: { say: "dream now", does: "Tidy stored facts + launch the deep agentic reflection over recent transcripts." } },
  memory_forget:         { kernel: "internal", risk: "destructive", capabilities: [], tags: [], blurb: { say: "forget that I use Coinbase", does: "Mark a fact as no longer true." }, undo: { irreversible: "forgetting is the point", previewsUntil: "confirm" } },
  memory_forget_imports: { kernel: "internal", risk: "destructive", capabilities: [], tags: [], undo: { irreversible: "forgetting is the point", previewsUntil: "confirm" } },
  memory_get:            { kernel: "internal", risk: "safe", capabilities: [], tags: ["memory-search"], blurb: { does: "Fetch a specific memory entry." }, loop: { discovery: true } },
  memory_ingest:         { kernel: "internal", risk: "workspace-write", capabilities: [], tags: [], blurb: { does: "Ingest external text/history into memory." }, pathArgs: [{ arg: "directory", action: "read" }, { arg: "file", action: "read" }] },
  // A recall bumps the hot-score timestamp of the facts it returns
  // (memory-recall.ts reinforceFacts): bookkeeping the user never loses, so
  // the tier stays "safe" — the mutating tiers would make a recall count as
  // work for the loop guards (loop.discovery) and the failover checks.
  memory_recall:         { kernel: "internal", risk: "safe", capabilities: [], tags: ["memory-search"], blurb: { does: "Recall stored facts." }, timeoutMs: 30_000, loop: { discovery: true } },
  memory_reflect:        { kernel: "internal", risk: "workspace-write", capabilities: [], tags: [], blurb: { say: "update what you know about me", does: "Refresh entity summaries + opinion confidence." } },
  memory_reindex:        { kernel: "internal", risk: "workspace-write", capabilities: [], tags: [] },
  memory_stats:          { kernel: "internal", risk: "safe", capabilities: [], tags: ["memory-search"], blurb: { does: "Show memory statistics." }, liveState: "fresh" },
  memory_set_user_field: { kernel: "internal", risk: "workspace-write", capabilities: [], tags: ["memory-facts"], essentialRank: 14, reads: ["session"], memoryWrite: true },
  memory_update_profile: { kernel: "internal", risk: "workspace-write", capabilities: [], tags: ["memory-facts"], essentialRank: 13, blurb: { does: "Update your user profile (name, role, preferences)." }, reads: ["session"], memoryWrite: true },
  remember:    { kernel: "internal", risk: "workspace-write", capabilities: [], tags: ["memory-facts"], essentialRank: 15, reads: ["session", "userMessage"], memoryWrite: true, rules: [{ id: "allow-remember", decision: "allow", reason: "Save durable fact to Facts DB (internal)", priority: 50 }] },
  update_fact: { kernel: "internal", risk: "workspace-write", capabilities: [], tags: ["memory-facts"], reads: ["session", "userMessage"], memoryWrite: true, rules: [{ id: "allow-update-fact", decision: "allow", reason: "Correct a fact in the Facts DB (internal)", priority: 50 }] },
  // forget's description sends a correction to update_fact ("A correction is
  // update_fact, not forget"). LM Studio eval 2026-10-18 (qwen3.6-27b, medium
  // tier): forget shipped without it, and told the boat had moved to slip 31
  // the model saved the new slip beside the old one, so slip 14 stayed current.
  forget:      { kernel: "internal", risk: "destructive", capabilities: [], tags: ["memory-facts"], essentialRank: 16, memoryWrite: true, companions: ["update_fact"], undo: { recoverable: "a soft delete of one fact; its history is kept" }, rules: [{ id: "allow-forget", decision: "allow", reason: "Soft-delete a fact in the Facts DB (internal)", priority: 50 }] },

  // ── Self-edit — sandboxed, but the merge mutates running source ──
  // Its intent gate checks the task against the last exchange; an autopilot
  // run anchors it at the run's checkout.
  self_edit: { kernel: "internal", risk: "destructive", capabilities: [], tags: [], essentialRank: 7, blurb: { say: "fix a bug in your own code", does: "Modify Agent X's own source or its config/ (system prompt, agent rules) via a coding agent. Requires the developer_mode setting; with it off, customization goes through connector manifests, workspace apps, and settings." }, timeoutMs: 0, reads: ["session", "lastTurn", "cwd"], undo: { irreversible: "the engine's own source", uncarded: "the engine's own source under git (git is the undo); a card per self-repair is the friction it exists to remove" }, rules: [{ id: "allow-self-edit", decision: "allow", reason: "Agent self-repair via Claude Code subprocess", priority: 50 }] },
};
