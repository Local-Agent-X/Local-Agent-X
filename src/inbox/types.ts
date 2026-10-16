// The user inbox item model: what the app needs to tell the person using it.
//
// `InboxItem` is the view every client sees (bell, WS frames, phone). The
// stored record adds fields that never leave the server: the producer's
// dedupe key, the soft-dismiss stamp, and for a refused unattended tool call
// the full call record that phase 2 re-runs on Approve. Keeping the call
// record server-side means a client can neither forge nor alter what runs.

export const INBOX_KINDS = ["agent-message", "job", "refused-action", "update", "app-error", "approval"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxLink {
  sessionId?: string;
  opId?: string;
  /** "agent-message": the escalating agent's template id. "job": the
   *  spawned agent's run id (AgentRun.id). */
  agentId?: string;
  issueId?: string;
}

export interface InboxAction {
  id: string;
  label: string;
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  body: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last producer update to a deduped item. */
  updatedAt?: number;
  readAt?: number;
  resolvedAt?: number;
  /** Pinned until resolved or dismissed; never pruned by age or the cap. */
  needsYou: boolean;
  link?: InboxLink;
  actions?: InboxAction[];
}

/** A tool call an unattended run refused because it needed a person: enough
 *  to run that exact call later through the normal gates. `args` excludes the
 *  dispatcher's `_`-prefixed internal keys. */
export interface RefusedCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  callContext: string;
  reason: string;
  /** What the run was, in words: the op's task or the cron job's name. */
  jobLabel: string;
  sessionId?: string;
  opId?: string;
  runId?: string;
}

export interface StoredInboxItem extends InboxItem {
  key?: string;
  dismissedAt?: number;
  refusedCall?: RefusedCallRecord;
}

export interface InboxInput {
  kind: InboxKind;
  title: string;
  body: string;
  needsYou: boolean;
  link?: InboxLink;
  actions?: InboxAction[];
  /** Stable producer key: a repeat with the same key updates the item. */
  key?: string;
  refusedCall?: RefusedCallRecord;
}

export interface InboxCounts {
  unread: number;
  needsYou: number;
}

/** Bare UI control frames over chat-ws broadcastAll (not ServerEvents; same
 *  family as settings_changed / learning_changed). `inbox_item` carries a new
 *  or changed item; `inbox_changed` tells every tab to refetch after a user
 *  action in any tab. */
export type InboxFrame =
  | ({ type: "inbox_item"; item: InboxItem; created: boolean } & InboxCounts)
  | ({ type: "inbox_changed"; action: "read" | "read_all" | "dismiss" | "resolve"; id?: string } & InboxCounts);
