// The inbox store: what the bell lists, what survives a restart, and what
// retention may and may not drop.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRetention, createInboxStore, INFO_RETENTION_MS, MAX_INBOX_ITEMS } from "./store.js";
import { toInboxView } from "./index.js";
import type { InboxInput, StoredInboxItem } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let file: string;
let now: number;
const clock = () => now;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-inbox-store-"));
  file = join(dir, "inbox.json");
  now = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const info = (over: Partial<InboxInput> = {}): InboxInput => ({ kind: "job", title: "Job finished", body: "done", needsYou: false, ...over });
const urgent = (over: Partial<InboxInput> = {}): InboxInput => ({ kind: "agent-message", title: "Ada needs you", body: "help", needsYou: true, ...over });

describe("adding and listing", () => {
  it("adds an item, lists needs-you first then newest first, and counts unread", () => {
    const store = createInboxStore(file, clock);
    const a = store.post(info({ title: "old info" })).item;
    now += 1000;
    const b = store.post(urgent()).item;
    now += 1000;
    const c = store.post(info({ title: "new info" })).item;
    expect(store.list().map((i) => i.id)).toEqual([b.id, c.id, a.id]);
    expect(store.counts()).toEqual({ unread: 3, needsYou: 1 });
    expect(a.createdAt).toBe(1_800_000_000_000);
  });

  it("survives a restart: a fresh store over the same file reads every item", () => {
    const first = createInboxStore(file, clock);
    const posted = first.post(urgent({ link: { agentId: "tpl-1", issueId: "iss-1" } })).item;
    first.post(info());
    const reopened = createInboxStore(file, clock);
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.get(posted.id)).toMatchObject({ title: "Ada needs you", needsYou: true, link: { agentId: "tpl-1", issueId: "iss-1" } });
  });

  it("ignores a corrupt file instead of failing the producer", () => {
    const store = createInboxStore(file, clock);
    store.post(info());
    rmSync(file);
    writeFileSync(file, "{not json", "utf-8");
    expect(store.list()).toEqual([]);
    store.post(info({ title: "after corruption" }));
    expect(store.list().map((i) => i.title)).toEqual(["after corruption"]);
  });
});

describe("dedupe by producer key", () => {
  it("a repeat with identical content is a no-op: same item, still read, file not rewritten", () => {
    const store = createInboxStore(file, clock);
    const first = store.post(info({ key: "update:1.2.3", kind: "update" }));
    store.markRead(first.item.id);
    const before = readFileSync(file, "utf-8");
    now += 60_000;
    const again = store.post(info({ key: "update:1.2.3", kind: "update" }));
    expect(again).toMatchObject({ created: false, changed: false });
    expect(again.item.id).toBe(first.item.id);
    expect(store.list()).toHaveLength(1);
    expect(store.get(first.item.id)?.readAt).toBeDefined();
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("a repeat whose content changed updates the one item and reopens it", () => {
    const store = createInboxStore(file, clock);
    const first = store.post(urgent({ key: "cron-failed:j1", kind: "job", body: "timeout" })).item;
    store.markRead(first.id);
    now += 60_000;
    const again = store.post(urgent({ key: "cron-failed:j1", kind: "job", body: "quota exceeded" }));
    expect(again).toMatchObject({ created: false, changed: true });
    expect(store.list()).toHaveLength(1);
    expect(store.get(first.id)).toMatchObject({ body: "quota exceeded", updatedAt: now, createdAt: first.createdAt });
    expect(store.get(first.id)?.readAt).toBeUndefined();
  });

  it("an empty link counts as no link, so it does not read as changed content", () => {
    const store = createInboxStore(file, clock);
    store.post(info({ key: "k", link: {} }));
    expect(store.post(info({ key: "k", link: {} }))).toMatchObject({ changed: false });
  });

  it("items without a key never dedupe", () => {
    const store = createInboxStore(file, clock);
    store.post(urgent());
    store.post(urgent());
    expect(store.list()).toHaveLength(2);
  });
});

describe("read, dismiss, resolve", () => {
  it("markRead and markAllRead clear the unread count but keep items listed", () => {
    const store = createInboxStore(file, clock);
    const a = store.post(info()).item;
    store.post(urgent());
    expect(store.markRead(a.id)).toBe(true);
    expect(store.counts().unread).toBe(1);
    expect(store.markAllRead()).toBe(1);
    expect(store.counts()).toEqual({ unread: 0, needsYou: 1 });
    expect(store.list()).toHaveLength(2);
    expect(store.markRead("nope")).toBe(false);
  });

  it("resolve unpins a needs-you item and marks it read; it stays listed", () => {
    const store = createInboxStore(file, clock);
    const a = store.post(urgent()).item;
    expect(store.resolve(a.id)).toBe(true);
    expect(store.counts()).toEqual({ unread: 0, needsYou: 0 });
    expect(store.list()[0]).toMatchObject({ id: a.id, resolvedAt: now, readAt: now });
  });

  it("dismiss hides the item; an identical keyed repeat stays dismissed, a changed one comes back", () => {
    const store = createInboxStore(file, clock);
    const a = store.post(urgent({ key: "k" })).item;
    expect(store.dismiss(a.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.counts()).toEqual({ unread: 0, needsYou: 0 });
    store.post(urgent({ key: "k" }));
    expect(store.list()).toEqual([]);
    store.post(urgent({ key: "k", body: "it happened again" }));
    expect(store.list().map((i) => i.id)).toEqual([a.id]);
  });

  it("resolveWhere resolves only open matching items", () => {
    const store = createInboxStore(file, clock);
    store.post(info({ kind: "update", key: "update:1" }));
    store.post(info());
    expect(store.resolveWhere((i) => i.kind === "update")).toBe(1);
    expect(store.resolveWhere((i) => i.kind === "update")).toBe(0);
  });
});

describe("retention", () => {
  it("prunes informational items 30 days after they last changed, never a needs-you item", () => {
    const store = createInboxStore(file, clock);
    const keep = store.post(urgent()).item;
    store.post(info({ title: "stale" }));
    now += INFO_RETENTION_MS - 1;
    store.post(info({ title: "fresh" }));
    expect(store.list()).toHaveLength(3);
    now += 2;
    store.post(info({ title: "trigger a write" }));
    expect(store.list().map((i) => i.title).sort()).toEqual(["Ada needs you", "fresh", "trigger a write"]);
    now += 365 * DAY;
    store.post(info({ title: "a year later" }));
    expect(store.list().map((i) => i.id)).toContain(keep.id);
  });

  it("a resolved needs-you item ages out like information", () => {
    const store = createInboxStore(file, clock);
    const a = store.post(urgent()).item;
    store.resolve(a.id);
    now += INFO_RETENTION_MS + 1;
    store.post(info());
    expect(store.get(a.id)).toBeUndefined();
  });

  it("the cap evicts dismissed, then read, then unread informational items, oldest first, and never a needs-you item", () => {
    const items: StoredInboxItem[] = [];
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_INBOX_ITEMS; i++) {
      items.push({ id: `u${i}`, kind: "agent-message", title: "", body: "", createdAt: t0 + i, needsYou: true });
    }
    items.push({ id: "unread-old", kind: "job", title: "", body: "", createdAt: t0, needsYou: false });
    items.push({ id: "read-new", kind: "job", title: "", body: "", createdAt: t0 + 5, readAt: t0 + 6, needsYou: false });
    items.push({ id: "dismissed", kind: "job", title: "", body: "", createdAt: t0 + 9, dismissedAt: t0 + 10, needsYou: false });
    const kept = applyRetention(items, t0 + 20);
    expect(kept).toHaveLength(MAX_INBOX_ITEMS);
    expect(kept.every((i) => i.needsYou)).toBe(true);

    const mixed = items.slice(MAX_INBOX_ITEMS - 2);
    for (let i = 0; i < MAX_INBOX_ITEMS - 3; i++) mixed.push({ id: `i${i}`, kind: "job", title: "", body: "", createdAt: t0 + 100 + i, needsYou: false });
    const trimmed = applyRetention(mixed, t0 + 500).map((i) => i.id);
    expect(trimmed).toHaveLength(MAX_INBOX_ITEMS);
    expect(trimmed).not.toContain("dismissed");
    expect(trimmed).not.toContain("read-new");
    expect(trimmed).toContain("unread-old");
  });
});

const approval = (over: Partial<InboxInput> = {}): InboxInput => ({
  kind: "approval", title: "t", body: "b", needsYou: true, key: "approval:x",
  deferredCall: { toolName: "bash", args: { command: "ls" }, callContext: "cron", reason: "r", jobLabel: "Scheduled job" },
  ...over,
});

describe("the client view", () => {
  it("never carries the producer key, the dismiss stamp or the deferred-call record", () => {
    const store = createInboxStore(file, clock);
    const { item } = store.post(approval());
    const view = toInboxView({ ...item, dismissedAt: 1 });
    expect(view).not.toHaveProperty("key");
    expect(view).not.toHaveProperty("dismissedAt");
    expect(view).not.toHaveProperty("deferredCall");
    expect(store.get(item.id)?.deferredCall).toMatchObject({ toolName: "bash", args: { command: "ls" } });
  });
});

describe("answering an approval", () => {
  it("the first claim resolves it with the answer; every later claim is refused, so its call runs at most once", () => {
    const store = createInboxStore(file, clock);
    const { item } = store.post(approval());
    const first = store.claimApproval(item.id, "approved");
    expect(first).toMatchObject({ kind: "claimed", item: { id: item.id, deferredCall: { toolName: "bash" } } });
    expect(store.get(item.id)).toMatchObject({ resolvedAt: now, readAt: now, resolution: "approved" });
    expect(store.claimApproval(item.id, "approved")).toEqual({ kind: "answered" });
    expect(store.claimApproval(item.id, "declined")).toEqual({ kind: "answered" });
    expect(store.get(item.id)?.resolution).toBe("approved");
    expect(toInboxView(store.get(item.id)!)).toMatchObject({ resolution: "approved" });
  });

  it("refuses an unknown id, an item that is not an approval, and a dismissed approval", () => {
    const store = createInboxStore(file, clock);
    const job = store.post(urgent()).item;
    const waved = store.post(approval({ key: "approval:y" })).item;
    store.dismiss(waved.id);
    expect(store.claimApproval("inb_nope", "approved")).toEqual({ kind: "missing" });
    expect(store.claimApproval(job.id, "approved")).toEqual({ kind: "not-approval" });
    expect(store.claimApproval(waved.id, "approved")).toEqual({ kind: "answered" });
  });

  it("dedupes while it waits; once answered, the same call parked again asks again", () => {
    const store = createInboxStore(file, clock);
    const { item } = store.post(approval());
    expect(store.post(approval())).toMatchObject({ created: false, changed: false });
    store.claimApproval(item.id, "approved");
    now += 60_000;
    const again = store.post(approval());
    expect(again).toMatchObject({ created: false, changed: true, item: { id: item.id } });
    expect(store.get(item.id)?.resolvedAt).toBeUndefined();
    expect(store.get(item.id)?.resolution).toBeUndefined();
    expect(store.counts().needsYou).toBe(1);
  });
});
