// Inbox: the desktop's user inbox (what the app needs to tell the person: an agent asking
// for them, a background job's outcome and where its result opens, a call an unattended
// run parked for their yes, a notice worth keeping), as its bell shows it. Carried on the
// `chat` data channel like workers.ts and, like workers, not scoped to a conversation: the
// desktop sends every inbox frame to every chat client.
//
// Live updates are the frames the desktop's own tabs read: `inbox_item` carries a new or
// changed item; `inbox_changed` says a user answered one (in any tab, on any device). A
// client that connects has missed both, so it asks for `inbox_list` and the desktop answers
// with the whole visible inbox (`inbox_snapshot`): anything the client holds that the
// snapshot leaves out was dismissed or pruned.

import { asNumber, asRecord, asString, type Rec } from "./guards.js";

/** What an item is. `approval`: a parked call waiting for Approve or Decline. `agent-message`:
 *  an agent escalating to the user. `job`: a finished background or scheduled run, with its
 *  result link. `update`: a newer desktop version. `notice`: a one-time notice worth keeping
 *  (a default the app changed). A kind this build does not know arrives as `notice`. */
export type InboxItemKind = "approval" | "agent-message" | "job" | "update" | "notice";
const KINDS: readonly string[] = ["approval", "agent-message", "job", "update", "notice"];

/** How an approval was answered. `failed`: the user said yes but the call could not run. */
export type InboxResolution = "approved" | "declined" | "failed";
const RESOLUTIONS: readonly string[] = ["approved", "declined", "failed"];

/** Where an item leads. `url` is where a job's result opens: a built app (`/apps/<name>/`),
 *  a document, a report page, or an absolute URL. */
export type InboxItemLink = { url?: string; sessionId?: string; opId?: string; agentId?: string; issueId?: string };

/** An action the desktop offers for the item (Approve / Decline on an approval). */
export type InboxItemAction = { id: string; label: string };

export type InboxItem = {
  id: string;
  kind: InboxItemKind;
  title: string;
  body: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last change to a repeated item. */
  updatedAt?: number;
  readAt?: number;
  resolvedAt?: number;
  resolution?: InboxResolution;
  /** Waits for the user: stays until resolved or dismissed. */
  needsYou: boolean;
  link?: InboxItemLink;
  actions?: InboxItemAction[];
};

export type InboxCounts = { unread: number; needsYou: number };

// ── desktop → phone ──

/** The answer to `inbox_list`: every visible item, complete, with the counts. */
export type InboxSnapshotFrame = { type: "inbox_snapshot"; items: InboxItem[] } & InboxCounts;

/** A new (`created`) or changed item, as the desktop's producers post it. */
export type InboxItemFrame = { type: "inbox_item"; item: InboxItem; created: boolean } & InboxCounts;

export type InboxChangeAction = "read" | "read_all" | "dismiss" | "resolve" | "approve" | "decline";
const CHANGE_ACTIONS: readonly string[] = ["read", "read_all", "dismiss", "resolve", "approve", "decline"];

/** A user answered an item somewhere. `item` is its new state when the action concerns one
 *  item that is still visible; a desktop that predates it sends the action and id alone. */
export type InboxChangedFrame = { type: "inbox_changed"; action: InboxChangeAction; id?: string; item?: InboxItem } & InboxCounts;

/** What an `inbox_item` or `inbox_changed` frame means for a client's list. `stale`: the
 *  desktop changed something it did not describe; ask for `inbox_list` again. */
export type InboxUpdate = { counts: InboxCounts } & (
  | { kind: "added" | "changed"; item: InboxItem }
  | { kind: "removed"; id: string }
  | { kind: "read"; id: string }
  | { kind: "read_all" }
  | { kind: "stale" }
);

// ── phone → desktop ──

/** Ask for an `inbox_snapshot`. Send it on every new link. */
export type InboxListFrame = { type: "inbox_list" };

/** Mark one item read, or every visible item when `id` is left out. */
export type InboxReadFrame = { type: "inbox_read"; id?: string };

/** Answer an item. `approve` / `decline` answer a waiting approval (the desktop runs the
 *  parked call, or skips it, exactly as its own bell would); `resolve` marks a needs-you item
 *  done; `dismiss` hides it. An action the desktop cannot carry out (an approval already
 *  answered, an unknown id) gets a top-level `error` frame back (parseControlError). */
export type InboxActAction = "approve" | "decline" | "dismiss" | "resolve";
export type InboxActFrame = { type: "inbox_act"; id: string; action: InboxActAction };

export type InboxOutboundFrame = InboxListFrame | InboxReadFrame | InboxActFrame;

/** What a client may offer for an item, the same rules as the desktop's bell: an open
 *  approval is answered only by Approve or Decline (no Done, no Dismiss); `open` follows the
 *  item's link on the client; `resolve` is Done for anything else that needs the user. */
export type InboxOffer = "approve" | "decline" | "open" | "read" | "resolve" | "dismiss";

export function isOpenApproval(item: InboxItem): boolean {
  return item.kind === "approval" && item.needsYou && item.resolvedAt === undefined;
}

export function inboxItemOffers(item: InboxItem): InboxOffer[] {
  const offers: InboxOffer[] = [];
  const awaiting = isOpenApproval(item);
  if (awaiting) offers.push("approve", "decline");
  if (item.link?.url) offers.push("open");
  if (item.readAt === undefined) offers.push("read");
  if (item.needsYou && item.resolvedAt === undefined && !awaiting) offers.push("resolve");
  if (!awaiting) offers.push("dismiss");
  return offers;
}

// ── parsers ──

function optionalNumber(rec: Rec, key: string): number | undefined {
  return asNumber(rec[key]) ?? undefined;
}

function parseLink(raw: unknown): InboxItemLink | undefined {
  const rec = asRecord(raw);
  if (rec === null) return undefined;
  const link: InboxItemLink = {};
  for (const key of ["url", "sessionId", "opId", "agentId", "issueId"] as const) {
    const value = asString(rec[key]);
    if (value) link[key] = value;
  }
  return Object.keys(link).length > 0 ? link : undefined;
}

function parseActions(raw: unknown): InboxItemAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const actions: InboxItemAction[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const id = rec === null ? null : asString(rec.id);
    const label = rec === null ? null : asString(rec.label);
    if (id !== null && label !== null) actions.push({ id, label });
  }
  return actions.length > 0 ? actions : undefined;
}

/** One item, or null when it lacks what a list needs (id, title, time, needs-you). */
export function parseInboxItem(raw: unknown): InboxItem | null {
  const rec = asRecord(raw);
  if (rec === null) return null;
  const id = asString(rec.id);
  const title = asString(rec.title);
  const createdAt = asNumber(rec.createdAt);
  if (id === null || title === null || createdAt === null || typeof rec.needsYou !== "boolean") return null;
  const kind = typeof rec.kind === "string" && KINDS.includes(rec.kind) ? (rec.kind as InboxItemKind) : "notice";
  const item: InboxItem = { id, kind, title, body: asString(rec.body) ?? "", createdAt, needsYou: rec.needsYou };
  for (const key of ["updatedAt", "readAt", "resolvedAt"] as const) {
    const value = optionalNumber(rec, key);
    if (value !== undefined) item[key] = value;
  }
  if (typeof rec.resolution === "string" && RESOLUTIONS.includes(rec.resolution)) item.resolution = rec.resolution as InboxResolution;
  const link = parseLink(rec.link);
  if (link) item.link = link;
  const actions = parseActions(rec.actions);
  if (actions) item.actions = actions;
  return item;
}

function parseCounts(rec: Rec): InboxCounts {
  return { unread: asNumber(rec.unread) ?? 0, needsYou: asNumber(rec.needsYou) ?? 0 };
}

/** An `inbox_snapshot` frame, or null for any other frame. A malformed item is dropped, not
 *  the snapshot. */
export function parseInboxSnapshot(raw: unknown): InboxSnapshotFrame | null {
  const msg = asRecord(raw);
  if (msg === null || msg.type !== "inbox_snapshot" || !Array.isArray(msg.items)) return null;
  const items: InboxItem[] = [];
  for (const entry of msg.items) {
    const item = parseInboxItem(entry);
    if (item !== null) items.push(item);
  }
  return { type: "inbox_snapshot", items, ...parseCounts(msg) };
}

/** What an inbound `inbox_item` or `inbox_changed` frame means for the list; null for any
 *  other frame or a malformed one. */
export function parseInboxUpdate(raw: unknown): InboxUpdate | null {
  const msg = asRecord(raw);
  if (msg === null) return null;
  const counts = parseCounts(msg);
  if (msg.type === "inbox_item") {
    const item = parseInboxItem(msg.item);
    return item === null ? null : { kind: msg.created === true ? "added" : "changed", item, counts };
  }
  if (msg.type !== "inbox_changed" || typeof msg.action !== "string" || !CHANGE_ACTIONS.includes(msg.action)) return null;
  if (msg.action === "read_all") return { kind: "read_all", counts };
  const id = asString(msg.id);
  if (id === null) return { kind: "stale", counts };
  if (msg.action === "dismiss") return { kind: "removed", id, counts };
  const item = parseInboxItem(msg.item);
  if (item !== null) return { kind: "changed", item, counts };
  return msg.action === "read" ? { kind: "read", id, counts } : { kind: "stale", counts };
}
