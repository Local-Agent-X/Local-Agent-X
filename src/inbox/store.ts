// Durable inbox store: one JSON file, written atomically through the shared
// JSON-store helper (src/util/json-store.ts), so items survive a restart.
//
// Retention is the product rule, not a cache policy:
//   - an item that needs the user (needsYou, unresolved) is never pruned —
//     not by age, not by the cap; only the user resolving or dismissing it
//     ends it;
//   - everything else (informational, resolved, dismissed) is pruned 30 days
//     after it last changed, and when the file is over the cap the oldest go
//     first: dismissed, then read, then unread.
// Dismiss is soft: the record stays (hidden) until pruned, so a producer that
// repeats the same keyed item does not resurrect what the user waved off. A
// repeat whose content changed is a new occurrence and reopens it.

import { randomBytes } from "node:crypto";
import { createJsonStore } from "../util/json-store.js";
import { INBOX_KINDS, type DeferredCallRecord, type InboxCounts, type InboxInput, type InboxResolution, type StoredInboxItem } from "./types.js";

export const INFO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_INBOX_ITEMS = 200;
const MAX_TITLE = 200;
const MAX_BODY = 4_000;

type InboxFile = { version: number; items: StoredInboxItem[] };

export interface PostResult {
  item: StoredInboxItem;
  created: boolean;
  /** False when a keyed repeat matched the stored content exactly. */
  changed: boolean;
}

export interface InboxStore {
  /** Visible items (not dismissed): needs-you first, then newest first. */
  list(): StoredInboxItem[];
  /** Any stored item by id, dismissed included. */
  get(id: string): StoredInboxItem | undefined;
  counts(): InboxCounts;
  post(input: InboxInput): PostResult;
  markRead(id: string): boolean;
  markAllRead(): number;
  dismiss(id: string): boolean;
  resolve(id: string): boolean;
  /** Resolve every open item `match` selects; returns how many changed. */
  resolveWhere(match: (item: StoredInboxItem) => boolean): number;
  /** Answer an open approval: resolves it with `resolution` in the same
   *  read-modify-write that checks it is still open, so of two answers to one
   *  item exactly one gets "claimed" and its call runs at most once. */
  claimApproval(id: string, resolution: InboxResolution): ApprovalClaim;
}

export type ApprovalClaim =
  | { kind: "claimed"; item: StoredInboxItem & { deferredCall: DeferredCallRecord } }
  | { kind: "missing" | "not-approval" | "answered" };

export function isPinned(item: StoredInboxItem): boolean {
  return item.needsYou && item.resolvedAt === undefined && item.dismissedAt === undefined;
}

function lastChanged(item: StoredInboxItem): number {
  return Math.max(item.createdAt, item.updatedAt ?? 0, item.readAt ?? 0, item.resolvedAt ?? 0, item.dismissedAt ?? 0);
}

function isValidItem(raw: unknown): raw is StoredInboxItem {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.title === "string" && typeof r.body === "string"
    && typeof r.createdAt === "number" && typeof r.needsYou === "boolean"
    && (INBOX_KINDS as readonly string[]).includes(r.kind as string);
}

/** Age prune, then cap. Never removes a pinned item. */
export function applyRetention(items: StoredInboxItem[], now: number): StoredInboxItem[] {
  const kept = items.filter((item) => isPinned(item) || now - lastChanged(item) < INFO_RETENTION_MS);
  if (kept.length <= MAX_INBOX_ITEMS) return kept;
  const rank = (item: StoredInboxItem): number => (item.dismissedAt !== undefined ? 0 : item.readAt !== undefined ? 1 : 2);
  const evictable = kept
    .filter((item) => !isPinned(item))
    .sort((a, b) => rank(a) - rank(b) || lastChanged(a) - lastChanged(b));
  const drop = new Set(evictable.slice(0, kept.length - MAX_INBOX_ITEMS).map((item) => item.id));
  return kept.filter((item) => !drop.has(item.id));
}

function newId(now: number): string {
  return `inb_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** `next` is the normalized form fromInput produced, so an empty link or
 *  action list compares equal to an absent one. */
function sameContent(item: StoredInboxItem, next: ReturnType<typeof fromInput>): boolean {
  return item.kind === next.kind && item.title === next.title && item.body === next.body
    && item.needsYou === next.needsYou
    && JSON.stringify(item.link ?? null) === JSON.stringify(next.link ?? null)
    && JSON.stringify(item.actions ?? null) === JSON.stringify(next.actions ?? null)
    && JSON.stringify(item.deferredCall ?? null) === JSON.stringify(next.deferredCall ?? null);
}

function fromInput(input: InboxInput): Omit<StoredInboxItem, "id" | "createdAt"> {
  return {
    kind: input.kind,
    title: input.title.slice(0, MAX_TITLE),
    body: input.body.slice(0, MAX_BODY),
    needsYou: input.needsYou,
    ...(input.link && Object.keys(input.link).length > 0 ? { link: input.link } : {}),
    ...(input.actions && input.actions.length > 0 ? { actions: input.actions } : {}),
    ...(input.key ? { key: input.key } : {}),
    ...(input.deferredCall ? { deferredCall: input.deferredCall } : {}),
  };
}

export function sortForDisplay(items: StoredInboxItem[]): StoredInboxItem[] {
  const at = (item: StoredInboxItem) => item.updatedAt ?? item.createdAt;
  return [...items].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || at(b) - at(a));
}

export function createInboxStore(filePath: string, clock: () => number = Date.now): InboxStore {
  const file = createJsonStore<InboxFile>(filePath, { defaults: () => ({ version: 1, items: [] }) });
  const load = (): StoredInboxItem[] => file.load().items.filter(isValidItem);
  const mutate = <R>(fn: (items: StoredInboxItem[], now: number) => R): R => {
    const now = clock();
    const items = load();
    const before = JSON.stringify(items);
    const result = fn(items, now);
    const kept = applyRetention(items, now);
    // Producers repeat themselves (an update check every few minutes); an
    // unchanged inbox is not rewritten.
    if (JSON.stringify(kept) !== before) file.save({ version: 1, items: kept });
    return result;
  };
  const visible = (items: StoredInboxItem[]) => items.filter((item) => item.dismissedAt === undefined);
  const touch = (id: string, fn: (item: StoredInboxItem, now: number) => boolean): boolean =>
    mutate((items, now) => {
      const item = items.find((candidate) => candidate.id === id);
      return item ? fn(item, now) : false;
    });

  return {
    list: () => sortForDisplay(visible(load())),
    get: (id) => load().find((item) => item.id === id),
    counts: () => {
      const items = visible(load());
      return { unread: items.filter((item) => item.readAt === undefined).length, needsYou: items.filter(isPinned).length };
    },
    post: (input) => mutate((items, now) => {
      const existing = input.key ? items.find((item) => item.key === input.key) : undefined;
      const next = fromInput(input);
      if (existing) {
        // An approval dedupes only while it waits: once answered (or waved
        // off) the yes or no was for that occurrence, and the same call parked
        // again asks again.
        if (sameContent(existing, next) && (existing.kind !== "approval" || isPinned(existing))) {
          return { item: existing, created: false, changed: false };
        }
        for (const field of ["link", "actions", "deferredCall", "readAt", "resolvedAt", "resolution", "dismissedAt"] as const) delete existing[field];
        Object.assign(existing, next, { updatedAt: now });
        return { item: existing, created: false, changed: true };
      }
      const item: StoredInboxItem = { id: newId(now), createdAt: now, ...next };
      items.push(item);
      return { item, created: true, changed: true };
    }),
    markRead: (id) => touch(id, (item, now) => {
      if (item.readAt === undefined) item.readAt = now;
      return true;
    }),
    markAllRead: () => mutate((items, now) => {
      let count = 0;
      for (const item of visible(items)) if (item.readAt === undefined) { item.readAt = now; count++; }
      return count;
    }),
    dismiss: (id) => touch(id, (item, now) => {
      if (item.dismissedAt === undefined) item.dismissedAt = now;
      return true;
    }),
    resolve: (id) => touch(id, (item, now) => {
      if (item.resolvedAt === undefined) item.resolvedAt = now;
      if (item.readAt === undefined) item.readAt = now;
      return true;
    }),
    resolveWhere: (match) => mutate((items, now) => {
      let count = 0;
      for (const item of visible(items)) {
        if (item.resolvedAt !== undefined || !match(item)) continue;
        item.resolvedAt = now;
        if (item.readAt === undefined) item.readAt = now;
        count++;
      }
      return count;
    }),
    claimApproval: (id, resolution) => mutate((items, now): ApprovalClaim => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return { kind: "missing" };
      if (item.kind !== "approval" || !item.deferredCall) return { kind: "not-approval" };
      if (!isPinned(item)) return { kind: "answered" };
      item.resolvedAt = now;
      item.resolution = resolution;
      if (item.readAt === undefined) item.readAt = now;
      return { kind: "claimed", item: item as StoredInboxItem & { deferredCall: DeferredCallRecord } };
    }),
  };
}
