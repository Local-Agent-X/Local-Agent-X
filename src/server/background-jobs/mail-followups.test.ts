// Replies owed and awaited, and promises in sent mail, over a fake mailbox.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImapSession, SearchObject } from "../../tools/email-imap.js";
import { listInbox } from "../../inbox/index.js";
import { loadCalendar } from "../../calendar/local-store.js";
import { emptyState } from "./mail-watch-state.js";
import {
  AWAITING_AFTER_MS, OWED_AFTER_MS, FORGET_AFTER_MS, applySentVerdicts, checkFollowUps, noteOwed, ownWords, parseSentVerdicts, readSentMail,
} from "./mail-followups.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-followups-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

/** Folders of messages with uid, Message-ID and In-Reply-To. */
function mailbox(folders: Record<string, Array<{ uid: number; id: string; inReplyTo?: string; subject?: string; body?: string }>>): ImapSession {
  return {
    listFolders: async () => [{ path: "Sent", name: "Sent", specialUse: "\\Sent", subscribed: true }],
    searchUids: async (folder: string, q: SearchObject) => {
      const list = folders[folder] ?? [];
      const query = q as { header?: Record<string, string>; uid?: string };
      if (query.header) return { uids: list.filter((m) => m.inReplyTo === query.header!["in-reply-to"]).map((m) => m.uid), uidValidity: "1" };
      const uids = list.map((m) => m.uid);
      if (query.uid === "*") return { uids: uids.length ? [Math.max(...uids)] : [], uidValidity: "1" };
      if (query.uid) { const from = Number(query.uid.split(":")[0]); return { uids: uids.filter((u) => u >= from), uidValidity: "1" }; }
      return { uids, uidValidity: "1" };
    },
    fetchMessages: async (folder: string, uids: number[] | null) => {
      const messages = (folders[folder] ?? []).filter((m) => uids?.includes(m.uid)).map((m) => ({ uid: m.uid, from: "me <me@x.com>", subject: m.subject ?? "s", date: "2026-11-10T10:00:00.000Z", messageId: m.id, snippet: "" }));
      return { messages, total: messages.length, returned: messages.length, truncated: false };
    },
    fetchBody: async (folder: string, uid: number) => {
      const m = (folders[folder] ?? []).find((x) => x.uid === uid)!;
      return { uid, from: "me", subject: m.subject ?? "s", date: "", messageId: m.id, body: m.body ?? "", contentType: "text/plain", truncated: false, attachments: [] };
    },
  } as unknown as ImapSession;
}

const DAY = 86_400_000;
const t0 = new Date("2026-11-10T10:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("replies the user owes", () => {
  it("raises an important mail still unanswered after two days, once, and drops it when answered", async () => {
    const state = emptyState();
    noteOwed(state, "me@x.com", { uid: 1, from: "Vic <vic@x.com>", subject: "Saturday?", date: t0.toISOString(), messageId: "<v1@x>", snippet: "" }, t0);
    const box = { Sent: [] as Array<{ uid: number; id: string; inReplyTo?: string }> };
    expect(await checkFollowUps(mailbox(box), state, "me@x.com", "Sent", later(OWED_AFTER_MS - 1000))).toBe(0);
    expect(await checkFollowUps(mailbox(box), state, "me@x.com", "Sent", later(OWED_AFTER_MS))).toBe(1);
    expect(listInbox().items[0]?.title).toBe("You haven't answered Vic: Saturday?");
    expect(await checkFollowUps(mailbox(box), state, "me@x.com", "Sent", later(OWED_AFTER_MS + DAY))).toBe(0);
    noteOwed(state, "me@x.com", { uid: 2, from: "Ann <a@x.com>", subject: "Offer", date: t0.toISOString(), messageId: "<a1@x>", snippet: "" }, t0);
    box.Sent.push({ uid: 9, id: "<r@x>", inReplyTo: "<a1@x>" });
    await checkFollowUps(mailbox(box), state, "me@x.com", "Sent", later(OWED_AFTER_MS));
    expect(state.owed["<a1@x>"]).toBeUndefined();
  });

  it("forgets what is two weeks old", async () => {
    const state = emptyState();
    noteOwed(state, "me@x.com", { uid: 1, from: "x", subject: "old", date: t0.toISOString(), messageId: "<o@x>", snippet: "" }, t0);
    await checkFollowUps(mailbox({}), state, "me@x.com", "Sent", later(FORGET_AFTER_MS + 1));
    expect(state.owed).toEqual({});
  });
});

describe("what the user sent", () => {
  it("first look only marks where to start; then reads new sent mail in the user's own words", async () => {
    const state = emptyState();
    const box = { Sent: [{ uid: 1, id: "<s1@x>" }] as Array<{ uid: number; id: string; body?: string; subject?: string }> };
    expect((await readSentMail(mailbox(box), state, "me@x.com", t0))?.messages).toEqual([]);
    box.Sent.push({ uid: 2, id: "<s2@x>", subject: "Contract", body: "I'll send the contract Friday.\n\nOn Mon, Vic wrote:\n> can you send it?" });
    const batch = await readSentMail(mailbox(box), state, "me@x.com", t0);
    expect(batch?.messages.map((m) => m.text)).toEqual(["I'll send the contract Friday."]);
  });

  it("a promise goes on the calendar; a question waits for an answer, raised after three days", async () => {
    const state = emptyState();
    const batch = { folder: "Sent", messages: [{ uid: 2, from: "me", subject: "Contract", date: t0.toISOString(), messageId: "<s2@x>", snippet: "", text: "" }] };
    await applySentVerdicts("me@x.com", batch, [{ uid: 2, promise: { what: "Send Vic the contract", due: "2026-11-13T09:00:00" }, awaitsReply: true }], state, t0);
    expect((await loadCalendar()).events.map((e) => e.title)).toEqual(["Promised: Send Vic the contract"]);
    expect(state.awaiting["<s2@x>"]).toBeDefined();
    expect(await checkFollowUps(mailbox({ INBOX: [] }), state, "me@x.com", "Sent", later(AWAITING_AFTER_MS))).toBe(1);
    expect(listInbox().items[0]?.title).toBe("No answer yet: Contract");
  });

  it("reads the model's verdicts strictly", () => {
    expect(parseSentVerdicts('{"messages":[{"uid":2,"promise":{"what":"x","due":"soon"},"awaits_reply":true},{"uid":9}]}', [2]))
      .toEqual([{ uid: 2, promise: null, awaitsReply: true }]);
    expect(parseSentVerdicts("nope", [1])).toBeNull();
    expect(ownWords("Hi\n-----Original Message-----\nold")).toBe("Hi");
  });
});
