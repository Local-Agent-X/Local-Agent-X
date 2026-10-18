// The user inbox item model: what the app needs to tell the person using it.
//
// `InboxItem` is the view every client sees (bell, WS frames, phone). The
// stored record adds fields that never leave the server: the producer's
// dedupe key, the soft-dismiss stamp, and for a call an unattended run parked
// for the user's yes (kind "approval") the full call record that Approve
// runs. Keeping the call record server-side means a client can neither forge
// nor alter what runs.

import type { Role } from "../rbac.js";
import type { CallContext } from "../tool-execution/context.js";

/** "notice": a one-time notice worth keeping (a default the app changed under
 *  the user), posted by `src/user-notice.ts`. The bell's tab-local "app-error"
 *  items are never stored or sent, so they are not a kind here; the phone's
 *  contract (agentxos `inbox.ts`) carries exactly these. */
export const INBOX_KINDS = ["agent-message", "job", "update", "approval", "notice"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxLink {
  sessionId?: string;
  opId?: string;
  /** "agent-message": the escalating agent's template id. "job": the
   *  spawned agent's run id (AgentRun.id). */
  agentId?: string;
  issueId?: string;
  /** "job": where the run's result opens — a built app's URL, a document it
   *  created (a /files/ path), a scheduled job's latest report page. The bell
   *  renders it as the item's Open link. */
  url?: string;
}

export interface InboxAction {
  id: string;
  label: string;
}

/** How the user answered an "approval" item. "failed": they said yes, but the
 *  call could no longer be run (its tool is gone). */
export type InboxResolution = "approved" | "declined" | "failed";

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
  resolution?: InboxResolution;
  /** Pinned until resolved or dismissed; never pruned by age or the cap. */
  needsYou: boolean;
  link?: InboxLink;
  actions?: InboxAction[];
}

/** A tool call an unattended run parked because it needed a person: enough to
 *  run that exact call later, as the run would have, through the normal
 *  gates. `args` excludes the dispatcher's `_`-prefixed internal keys. */
export interface DeferredCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  callContext: CallContext;
  reason: string;
  /** What the run was, in words: the op's task or the cron job's name. */
  jobLabel: string;
  /** The role the run dispatched as, so RBAC judges the approved call as the
   *  agent that made it, never as the user who said yes. */
  callerRole?: Role;
  /** The scheduled job, when the run was one: its deferrals dedupe across runs. */
  cronJobId?: string;
  sessionId?: string;
  opId?: string;
  runId?: string;
}

export interface StoredInboxItem extends InboxItem {
  key?: string;
  dismissedAt?: number;
  deferredCall?: DeferredCallRecord;
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
  deferredCall?: DeferredCallRecord;
}

export interface InboxCounts {
  unread: number;
  needsYou: number;
}

/** Bare UI control frames over chat-ws broadcastAll (not ServerEvents; same
 *  family as settings_changed / learning_changed). `inbox_item` carries a new
 *  or changed item; `inbox_changed` tells every tab to refetch after a user
 *  action in any tab (or on any device). Both reach the phone through the
 *  broker chat bridge, so their shape is the phone contract (agentxos
 *  `inbox.ts`; `src/broker-transport/inbox-contract.test.ts`): `item` on
 *  `inbox_changed` is the item's new state when one visible item is concerned,
 *  so the phone applies the change without asking for the list again. */
export type InboxFrame =
  | ({ type: "inbox_item"; item: InboxItem; created: boolean } & InboxCounts)
  | ({ type: "inbox_changed"; action: "read" | "read_all" | "dismiss" | "resolve" | "approve" | "decline"; id?: string; item?: InboxItem } & InboxCounts);
