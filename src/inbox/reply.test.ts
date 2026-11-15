import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxStore, postToInbox } from "./index.js";
import { replyToInboxItem, type InboxReplyDeps } from "./reply.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-inbox-reply-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

function deps() {
  const chats = new Set<string>();
  const sent: Array<{ sessionId: string; message: string }> = [];
  const external: string[] = [];
  const d: InboxReplyDeps = {
    chatExists: (id) => chats.has(id),
    createChat: async ({ id }) => { chats.add(id); },
    send: (sessionId, message) => { sent.push({ sessionId, message }); },
    markExternal: (id) => { external.push(id); },
  };
  return { d, chats, sent, external };
}

describe("reply from the inbox", () => {
  it("opens a new chat about the item, the user's words first and the mail fenced as outside content", async () => {
    const item = postToInbox({ kind: "agent-message", title: "Acme Hiring: Interview on Tuesday", body: "Interview invite from Acme", needsYou: false, key: "mail:me@x.com:<1@x>" })!;
    const { d, sent, external } = deps();
    const r = await replyToInboxItem(item.id, "  Accept for 10am and add it to my calendar ", d);
    expect(r).toMatchObject({ ok: true, created: true });
    const sessionId = (r as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^reply-[0-9a-f]{16}$/);
    expect(sent[0]!.message.startsWith("Accept for 10am and add it to my calendar")).toBe(true);
    expect(sent[0]!.message).toContain("Interview invite from Acme");
    expect(sent[0]!.message).toMatch(/EXTERNAL/);
    expect(external).toEqual([sessionId]);
    const stored = inboxStore().get(item.id)!;
    expect(stored.link?.sessionId).toBe(sessionId);
    expect(stored.readAt).toBeDefined();
  });

  it("a second reply continues the same chat, without quoting the item again", async () => {
    const item = postToInbox({ kind: "notice", title: "Mail digest: 3 messages", body: "• a\n• b", needsYou: false, key: "mail-digest:2026-11-14" })!;
    const { d, sent } = deps();
    const first = await replyToInboxItem(item.id, "anything urgent in there?", d);
    const second = await replyToInboxItem(item.id, "and the second one?", d);
    expect(second).toEqual({ ok: true, sessionId: (first as { sessionId: string }).sessionId, created: false });
    expect(sent[1]).toEqual({ sessionId: (first as { sessionId: string }).sessionId, message: "and the second one?" });
  });

  it("starts a fresh chat when the linked one was deleted, and does not mark a chat external for LAX's own notices", async () => {
    const item = postToInbox({ kind: "job", title: "Background task finished", body: "done", needsYou: false })!;
    const { d, chats, external } = deps();
    const first = await replyToInboxItem(item.id, "show me", d) as { sessionId: string };
    chats.delete(first.sessionId);
    const again = await replyToInboxItem(item.id, "show me again", d);
    expect(again).toMatchObject({ ok: true, created: true });
    expect(external).toEqual([]);
  });

  it("refuses an empty reply and a missing item", async () => {
    const item = postToInbox({ kind: "notice", title: "t", body: "", needsYou: false })!;
    const { d } = deps();
    const send = vi.spyOn(d, "send");
    expect(await replyToInboxItem(item.id, "   ", d)).toEqual({ ok: false, refused: "empty" });
    expect(await replyToInboxItem("inb_nope", "hi", d)).toEqual({ ok: false, refused: "missing" });
    expect(send).not.toHaveBeenCalled();
  });
});
